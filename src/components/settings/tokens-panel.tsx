"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { api, type DocumentSummaryDto } from "@/lib/api";
import { TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY, type TokenScopeName } from "@/lib/mcp";
import { AgentConnectCard, mcpHttpConfigFor, useOrigin } from "@/components/settings/agent-connect-card";
import { CopilotChecklist } from "@/components/settings/copilot-checklist";

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scope: TokenScopeName;
  documentIds: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastMcpSeenAt: string | null;
  lastMcpCallAt: string | null;
  expiresAt: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.text();
  const data = body ? JSON.parse(body) : null;
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? res.statusText);
  return data as T;
}

function CopyField({ value, label }: { value: string; label: string }) {
  const code = useRef<HTMLElement>(null);
  const { copy, label: buttonLabel, copied } = useCopy(value, code);
  return (
    <div className="flex items-center gap-2">
      {/* break-all instead of truncate: the whole token is readable and selectable (LAN, no clipboard API). */}
      <code ref={code} className="min-w-0 flex-1 select-text break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink" data-testid={`copy-${label}`}>
        {value}
      </code>
      <button type="button" className="btn btn-outline btn-sm shrink-0 gap-1.5" onClick={copy} aria-label={`Copy ${label}`} data-testid={`copy-${label}-button`}>
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {buttonLabel}
      </button>
    </div>
  );
}

/** The scope chip shown in the token list and under the connect cards. */
export function ScopeChip({ scope, className }: { scope: TokenScopeName; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2 ${className ?? ""}`}
      title={`${TOKEN_SCOPE_LABEL[scope]}: ${TOKEN_SCOPE_SUMMARY[scope]}`}
      data-testid="token-scope-chip"
      data-scope={scope}
    >
      {scope}
    </span>
  );
}

const SCOPES: TokenScopeName[] = ["read", "comment", "full"];

export function TokensPanel({ origin, userLogin, next, hasAgentRequests = false }: { origin: string; userLogin: string; next?: string | null; hasAgentRequests?: boolean }) {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [name, setName] = useState("GitHub Copilot CLI");
  const [expires, setExpires] = useState<string>("90");
  const [scope, setScope] = useState<TokenScopeName>("comment");
  const [restrict, setRestrict] = useState(false);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [documents, setDocuments] = useState<DocumentSummaryDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; name: string; scope: TokenScopeName; documentIds: string[] | null } | null>(null);
  // The browser's origin wins (LAN access, tunnels): the config must point where the user actually is.
  const liveOrigin = useOrigin(origin);
  const base = liveOrigin || origin;

  const load = useCallback(async () => {
    try {
      const res = await request<{ tokens: TokenRow[] }>("/api/tokens");
      setTokens(res.tokens);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tokens");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // The document picker lists what the user can see; fetched once it is opened.
  useEffect(() => {
    if (!restrict || documents !== null) return;
    api.documents
      .list()
      .then((res) => setDocuments(res.documents))
      .catch(() => setDocuments([]));
  }, [restrict, documents]);

  const toggleDocument = (id: string) => setDocumentIds((ids) => (ids.includes(id) ? ids.filter((d) => d !== id) : [...ids, id]));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await request<{ token: { token: string; name: string; scope: TokenScopeName; documentIds: string[] | null } }>("/api/tokens", {
        method: "POST",
        body: JSON.stringify({ name, expiresInDays: expires === "never" ? null : Number(expires), scope, documentIds: restrict ? documentIds : [] }),
      });
      setCreated({ token: res.token.token, name: res.token.name, scope: res.token.scope, documentIds: res.token.documentIds });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create token");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: TokenRow) => {
    if (!confirm(`Revoke “${t.name}”? Anything using it will stop working immediately.`)) return;
    await request(`/api/tokens/${t.id}`, { method: "DELETE" });
    await load();
  };

  const mcpConfig = mcpHttpConfigFor(base, created?.token ?? "mdk_…");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <Bot size={20} className="text-accent" /> Agents &amp; API access
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-3">
          Personal access tokens let agents such as GitHub Copilot, scripts, and other tools create and edit your documents, leave comments, and propose
          suggestions. Everything they do shows up live for collaborators and is attributed to <strong>{userLogin} via &lt;token name&gt;</strong>. A token is never
          wider than you: pick a <em>Read</em> or <em>Comment &amp; suggest</em> scope, or limit it to a few documents, and it cannot do more.
        </p>
        {next && (
          <a className="btn btn-outline btn-sm mt-3 gap-1.5" href={next} data-testid="settings-back-to-document">
            <ArrowLeft size={14} /> Back to the document
          </a>
        )}
      </div>

      <CopilotChecklist hasAgentRequests={hasAgentRequests} />

      <AgentConnectCard origin={liveOrigin} token={created?.token ?? null} scope={created?.scope ?? null} hideTokenStep />

      <div className="rounded-2xl border border-line bg-surface p-5" id="tokens">
        <h2 className="mb-3 text-sm font-semibold text-ink">Create a token</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium text-ink-3">
            Name (shown as the agent)
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub Copilot CLI" data-testid="token-name" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            Expires
            <select className="select" value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
              <option value="never">Never</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary gap-2" disabled={busy || !name.trim()} data-testid="token-create">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create token
          </button>
          <fieldset className="flex w-full flex-col gap-1.5" data-testid="token-scope">
            <legend className="mb-1 text-xs font-medium text-ink-3">Scope</legend>
            {SCOPES.map((s) => (
              <label key={s} className="flex cursor-pointer items-start gap-2 text-sm text-ink-2">
                <input type="radio" name="token-scope" value={s} checked={scope === s} onChange={() => setScope(s)} className="mt-1" data-testid={`token-scope-${s}`} />
                <span>
                  <span className="font-medium text-ink">{TOKEN_SCOPE_LABEL[s]}</span>
                  <span className="text-ink-3"> — {TOKEN_SCOPE_SUMMARY[s]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex w-full flex-col gap-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} data-testid="token-restrict" />
              <span className="font-medium text-ink">Only these documents</span>
              <span className="text-ink-3">— every other document answers 404 to this token; leave off for all</span>
            </label>
            {restrict && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-line bg-surface-2 p-2" data-testid="token-documents">
                {documents === null ? (
                  <div className="px-1 py-1 text-xs text-ink-3">Loading your documents…</div>
                ) : documents.length === 0 ? (
                  <div className="px-1 py-1 text-xs text-ink-3">No documents yet.</div>
                ) : (
                  documents.map((d) => (
                    <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm text-ink-2 hover:bg-surface">
                      <input type="checkbox" checked={documentIds.includes(d.id)} onChange={() => toggleDocument(d.id)} data-testid={`token-document-${d.id}`} />
                      <span className="truncate">{d.title}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
        </form>
        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">{error}</div>}

        {created && (
          <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40" data-testid="token-created">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium text-green-900 dark:text-green-200">
              <span>Token “{created.name}” created. Copy it now; it will not be shown again.</span>
              <ScopeChip scope={created.scope} />
              {created.documentIds?.length ? <span className="text-xs font-normal text-ink-3">{created.documentIds.length === 1 ? "1 document" : `${created.documentIds.length} documents`}</span> : null}
            </div>
            <CopyField value={created.token} label="token" />
            <details className="mt-3 text-sm text-ink-2">
              <summary className="cursor-pointer select-none font-medium text-ink">How to use it</summary>
              <div className="mt-3 flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-3">REST</div>
                  <CopyField value={`curl -H "Authorization: Bearer ${created.token}" ${base}/api/me`} label="curl" />
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-3">MCP (GitHub Copilot, Claude, Cursor…)</div>
                  <pre className="select-text whitespace-pre-wrap break-all rounded-lg border border-line bg-surface p-3 font-mono text-xs text-ink-2">{mcpConfig}</pre>
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink">
          <KeyRound size={16} className="text-ink-3" /> Your tokens
        </div>
        {tokens === null ? (
          <div className="px-5 py-6 text-sm text-ink-3">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="px-5 py-6 text-sm text-ink-3">No tokens yet.</div>
        ) : (
          <ul className="divide-y divide-line">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-4 px-5 py-3" data-testid="token-row">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{t.name}</span>
                    <ScopeChip scope={t.scope} />
                    <span className="shrink-0 text-xs text-ink-3" data-testid="token-documents-count">
                      {t.documentIds?.length ? (t.documentIds.length === 1 ? "1 document" : `${t.documentIds.length} documents`) : "all documents"}
                    </span>
                  </div>
                  <div className="truncate font-mono text-xs text-ink-3">{t.prefix}…</div>
                </div>
                <div className="hidden text-xs text-ink-3 sm:block">
                  Created {relativeTime(t.createdAt)}
                  {t.lastUsedAt ? ` · used ${relativeTime(t.lastUsedAt)}` : " · never used"}
                  {t.expiresAt ? ` · expires ${relativeTime(t.expiresAt)}` : ""}
                </div>
                <button type="button" className="icon-btn h-8 w-8 text-ink-3 hover:text-danger" onClick={() => void revoke(t)} aria-label={`Revoke ${t.name}`} data-testid="token-revoke">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
