"use client";

import { useId, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { CopyBlock } from "@/components/agents/copy-block";
import type { ApiTokens } from "@/components/agents/use-api-tokens";
import { RelativeTime } from "@/components/ui/relative-time";
import { api, apiErrorText, type ApiTokenDto, type CreatedApiTokenDto } from "@/lib/api";
import { hasConnected, isActiveKey, lastSeenAt } from "@/lib/agent-keys";
import { TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY } from "@/lib/mcp";
import { cn } from "@/lib/utils";

type Mode = "view" | "rename" | "replace" | "revoke";

function documentsText(key: Pick<ApiTokenDto, "documentIds">): string {
  if (key.documentIds === null) return "all documents";
  return key.documentIds.length === 1 ? "1 document" : `${key.documentIds.length} documents`;
}

const ERROR_CLASS = "rounded-lg bg-red-50 px-3 py-2 text-sm text-danger wrap-anywhere dark:bg-red-950/40";

function KeyRow({ keyRow: key, reload, patch, onReplaced }: { keyRow: ApiTokenDto; reload: ApiTokens["reload"]; patch: ApiTokens["patch"]; onReplaced: (name: string, key: CreatedApiTokenDto) => void }) {
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [name, setName] = useState(key.name);
  const [busy, setBusy] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = isActiveKey(key);
  const seen = lastSeenAt(key);

  const run = async (action: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(apiErrorText(e, failure));
    } finally {
      setBusy(false);
    }
  };

  const rename = () =>
    run(async () => {
      const next = name.trim();
      if (!next || next === key.name) return setMode("view");
      const res = await api.tokens.update(key.id, { name: next });
      patch(key.id, { name: res.token.name });
      setMode("view");
    }, "Could not rename the key.");

  const replace = () =>
    run(async () => {
      const res = await api.tokens.replace(key.id);
      onReplaced(key.name, res.token);
      await reload();
    }, "Could not replace the key.");

  const revoke = () =>
    run(async () => {
      await api.tokens.revoke(key.id);
      await reload();
    }, "Could not revoke the key.");

  // One request at a time: the switch flips at once, is locked while the server answers, and flips back if it refuses.
  const toggleMayAsk = async () => {
    if (askBusy) return;
    const next = !key.collaboratorsMayAsk;
    setAskBusy(true);
    setError(null);
    patch(key.id, { collaboratorsMayAsk: next });
    try {
      await api.tokens.update(key.id, { collaboratorsMayAsk: next });
    } catch (e) {
      patch(key.id, { collaboratorsMayAsk: !next });
      setError(apiErrorText(e, `Could not update “${key.name}”.`));
    } finally {
      setAskBusy(false);
    }
  };

  return (
    <li className={cn("px-5 py-3", !active && "opacity-70")} data-testid="key-row" data-key-id={key.id}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium text-ink" title={key.name} data-testid="key-name">
              {key.name}
            </span>
            <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-ink-2" data-testid="key-scope" data-scope={key.scope}>
              {TOKEN_SCOPE_LABEL[key.scope]}
            </span>
            {!active && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-danger dark:bg-red-950/40">Expired</span>}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3" data-testid="key-status" data-connected={hasConnected(key) || undefined}>
            {hasConnected(key) && seen ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                <span>
                  Connected · <RelativeTime date={seen} prefix="last seen " />
                </span>
              </>
            ) : (
              <span>Not connected yet</span>
            )}
            <span aria-hidden="true">·</span>
            <span>{documentsText(key)}</span>
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0 gap-1"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`Manage ${key.name}`}
          onClick={() => setOpen((value) => !value)}
          data-testid="key-manage"
        >
          Manage <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div id={detailsId} className="mt-3 flex flex-col gap-3 rounded-xl bg-surface-2 p-3" data-testid="key-details">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-3">Key</dt>
            <dd className="font-mono text-ink-2">{key.prefix}…</dd>
            <dt className="text-ink-3">Can</dt>
            <dd className="text-ink-2">
              {TOKEN_SCOPE_LABEL[key.scope]}. {TOKEN_SCOPE_SUMMARY[key.scope]}
            </dd>
            <dt className="text-ink-3">Created</dt>
            <dd className="text-ink-2">
              <RelativeTime date={key.createdAt} />
            </dd>
            <dt className="text-ink-3">Last request</dt>
            <dd className="text-ink-2" data-testid="key-last-request">
              {seen ? <RelativeTime date={seen} /> : "Never"}
            </dd>
            <dt className="text-ink-3">Last tool call</dt>
            <dd className="text-ink-2" data-testid="key-last-tool-call">
              {key.lastMcpCallAt ? <RelativeTime date={key.lastMcpCallAt} /> : "Never"}
            </dd>
            <dt className="text-ink-3">Expires</dt>
            <dd className="text-ink-2">{key.expiresAt ? <RelativeTime date={key.expiresAt} /> : "Never"}</dd>
          </dl>

          {active && (
            <div className="flex items-start gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={key.collaboratorsMayAsk}
                aria-labelledby={`${detailsId}-ask`}
                className="switch mt-px"
                disabled={askBusy}
                onClick={() => void toggleMayAsk()}
                data-testid="key-may-ask"
              />
              <div className="min-w-0 text-xs leading-5">
                <div id={`${detailsId}-ask`} className="font-medium text-ink-2">
                  People I share documents with can ask this agent
                </div>
                <div className="text-ink-3">Off: only you can send it requests. On: your collaborators can @mention it too.</div>
              </div>
            </div>
          )}

          {mode === "view" && (
            <div className="flex flex-wrap gap-2">
              {active && (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setMode("rename")} data-testid="key-rename">
                  Rename
                </button>
              )}
              {active && (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setMode("replace")} data-testid="key-replace">
                  Replace key
                </button>
              )}
              <button type="button" className="btn btn-outline btn-sm text-danger" onClick={() => setMode("revoke")} data-testid="key-revoke">
                Revoke
              </button>
            </div>
          )}

          {mode === "rename" && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void rename();
              }}
            >
              <label className="sr-only" htmlFor={`${detailsId}-name`}>
                Key name
              </label>
              <input id={`${detailsId}-name`} className="input h-8 min-w-40 flex-1" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus data-testid="key-rename-input" />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()} data-testid="key-rename-save">
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : "Save"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setName(key.name);
                  setMode("view");
                  setError(null);
                }}
              >
                Cancel
              </button>
            </form>
          )}

          {mode === "replace" && (
            <div className="flex flex-col gap-2 text-sm" data-testid="key-replace-confirm">
              <p className="text-ink-2">Make a new key with the same access. Everything using this one stops working until you give it the new key.</p>
              <div className="flex gap-2">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void replace()} disabled={busy} data-testid="key-replace-confirm-button">
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : "Replace key"}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("view")} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {mode === "revoke" && (
            <div className="flex flex-col gap-2 text-sm" data-testid="key-revoke-confirm">
              <p className="text-ink-2">Revoke “{key.name}”? Anything using it stops working immediately.</p>
              <div className="flex gap-2">
                <button type="button" className="btn btn-danger btn-sm" onClick={() => void revoke()} disabled={busy} data-testid="key-revoke-confirm-button">
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : "Revoke key"}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("view")} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className={ERROR_CLASS} role="alert" data-testid="key-error">
              {error}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The user's keys, one calm row each; rename, replace and revoke sit behind Manage. */
export function KeysList({ tokens, error, reload, patch }: ApiTokens) {
  const [replaced, setReplaced] = useState<{ name: string; token: CreatedApiTokenDto } | null>(null);

  return (
    <div className="rounded-2xl border border-line bg-surface" id="tokens" data-testid="keys-card">
      <h2 className="border-b border-line px-5 py-3 text-sm font-semibold text-ink">Your keys</h2>

      {replaced && (
        <div className="m-5 flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3" role="status" data-testid="key-replaced">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-ink-2">
              New key for <strong className="font-semibold text-ink">{replaced.name}</strong>. Copy it now: it is shown only once. Then update every agent that used the old key.
            </p>
            <button type="button" className="icon-btn h-7 w-7 shrink-0" onClick={() => setReplaced(null)} aria-label="Dismiss new key">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <CopyBlock value={replaced.token.token} label="Copy new key" primary testId="key-replaced-secret" copyTestId="key-replaced-copy" />
        </div>
      )}

      {tokens === null && !error && <p className="px-5 py-5 text-sm text-ink-3">Loading…</p>}
      {error && (
        <div className="m-5">
          <div className={ERROR_CLASS} role="alert" data-testid="keys-error">
            <div>{error}</div>
            <button type="button" className="btn btn-outline btn-sm mt-2" onClick={() => void reload()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {tokens && tokens.length === 0 && <p className="px-5 py-5 text-sm text-ink-3">No keys yet. Connect an agent above and it creates one for you.</p>}
      {tokens && tokens.length > 0 && (
        <ul className="divide-y divide-line">
          {tokens.map((key) => (
            <KeyRow key={key.id} keyRow={key} reload={reload} patch={patch} onReplaced={(name, token) => setReplaced({ name, token })} />
          ))}
        </ul>
      )}
    </div>
  );
}
