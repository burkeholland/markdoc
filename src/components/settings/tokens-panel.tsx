"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { relativeTime } from "@/lib/utils";

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
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
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink" title={value} data-testid={`copy-${label}`}>
        {value}
      </code>
      <button
        type="button"
        className="btn btn-outline btn-sm gap-1.5"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function TokensPanel({ origin, userLogin }: { origin: string; userLogin: string }) {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [name, setName] = useState("GitHub Copilot CLI");
  const [expires, setExpires] = useState<string>("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const base = origin || (typeof window !== "undefined" ? window.location.origin : "");

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

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await request<{ token: { token: string; name: string } }>("/api/tokens", {
        method: "POST",
        body: JSON.stringify({ name, expiresInDays: expires === "never" ? null : Number(expires) }),
      });
      setCreated({ token: res.token.token, name: res.token.name });
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

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        markdoc: {
          command: "node",
          args: ["<path-to-markdoc>/mcp/server.mjs"],
          env: { MARKDOC_URL: base, MARKDOC_TOKEN: created?.token ?? "mdk_…" },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <Bot size={20} className="text-accent" /> Agents &amp; API access
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-3">
          Personal access tokens let agents such as GitHub Copilot, scripts, and other tools create and edit your documents, leave comments, and propose
          suggestions. Everything they do shows up live for collaborators and is attributed to <strong>{userLogin} via &lt;token name&gt;</strong>. Tokens have
          the same access you have.
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-5">
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
        </form>
        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</div>}

        {created && (
          <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4" data-testid="token-created">
            <div className="mb-2 text-sm font-medium text-green-900">Token “{created.name}” created. Copy it now; it will not be shown again.</div>
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
                  <pre className="overflow-x-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs text-ink-2">{mcpConfig}</pre>
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
                  <div className="truncate text-sm font-medium text-ink">{t.name}</div>
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
