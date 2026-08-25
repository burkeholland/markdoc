"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Plus, Send, Trash2, Webhook } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  documentIds: string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: { status: number; at: string; attempt: number; event: string } | null;
}

/** Checkbox labels; `suggestion` covers both decisions like the long-poll does. */
const EVENT_CHOICES: { id: string; label: string; types: string[] }[] = [
  { id: "request.created", label: "request.created", types: ["request.created"] },
  { id: "mention", label: "mention", types: ["mention"] },
  { id: "comment.added", label: "comment.added", types: ["comment.added"] },
  { id: "comment.replied", label: "comment.replied", types: ["comment.replied"] },
  { id: "review.created", label: "review.created", types: ["review.created"] },
  { id: "suggestion", label: "suggestion.accepted/rejected", types: ["suggestion.accepted", "suggestion.rejected"] },
  { id: "content.changed", label: "content.changed", types: ["content.changed"] },
];
const DEFAULT_CHOICES = ["request.created", "mention", "comment.added", "comment.replied"];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.text();
  const data = body ? JSON.parse(body) : null;
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? res.statusText);
  return data as T;
}

function SecretField({ value }: { value: string }) {
  const code = useRef<HTMLElement>(null);
  const { copy, label, copied } = useCopy(value, code);
  return (
    <div className="flex items-center gap-2">
      <code ref={code} className="min-w-0 flex-1 select-text break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink" data-testid="webhook-secret">
        {value}
      </code>
      <button type="button" className="btn btn-outline btn-sm shrink-0 gap-1.5" onClick={copy} aria-label="Copy secret">
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {label}
      </button>
    </div>
  );
}

function deliveryLabel(h: WebhookRow): { text: string; tone: "ok" | "bad" | "muted" } {
  if (!h.active) return { text: `disabled after ${h.failures} failures`, tone: "bad" };
  if (!h.lastDelivery) return { text: "no deliveries yet", tone: "muted" };
  const d = h.lastDelivery;
  const ok = d.status >= 200 && d.status < 300;
  if (ok) return { text: `${d.status} · ${relativeTime(d.at)}`, tone: "ok" };
  return { text: `failed ×${h.failures}${d.status ? ` · ${d.status}` : " · no response"} · ${relativeTime(d.at)}`, tone: "bad" };
}

export function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<string[]>(DEFAULT_CHOICES);
  const [docs, setDocs] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; secret: string; url: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await request<{ webhooks: WebhookRow[] }>("/api/webhooks");
      setHooks(res.webhooks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load webhooks");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const events = EVENT_CHOICES.filter((c) => choices.includes(c.id)).flatMap((c) => c.types);
      const documentIds = docs
        .split(/[\s,]+/)
        .map((s) => s.trim().replace(/^.*\/d\//, ""))
        .filter(Boolean);
      const res = await request<{ webhook: WebhookRow & { secret: string } }>("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, events, documentIds: documentIds.length ? documentIds : null }),
      });
      setCreated({ id: res.webhook.id, secret: res.webhook.secret, url: res.webhook.url });
      setUrl("");
      setDocs("");
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add webhook");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (h: WebhookRow) => {
    if (!confirm(`Delete the webhook to ${h.url}?`)) return;
    await request(`/api/webhooks/${h.id}`, { method: "DELETE" });
    if (created?.id === h.id) setCreated(null);
    await load();
  };

  const test = async (h: WebhookRow) => {
    setTesting(h.id);
    setError(null);
    try {
      await request(`/api/webhooks/${h.id}/test`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-surface" id="webhooks" data-testid="webhooks-card">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink">
        <Webhook size={16} className="text-ink-3" /> Webhooks
        <button type="button" className="btn btn-outline btn-sm ml-auto gap-1.5" onClick={() => setAdding((v) => !v)} data-testid="webhook-add">
          <Plus size={14} /> Add webhook
        </button>
      </div>
      <p className="px-5 pt-3 text-sm leading-6 text-ink-3">
        Push the events <code className="text-xs">markdoc_watch</code> returns to an HTTP endpoint instead of long-polling: a GitHub Actions job, a bot, a Slack bridge. Each
        delivery is a JSON <code className="text-xs">POST</code> with <code className="text-xs">X-Markdoc-Event</code>, <code className="text-xs">X-Markdoc-Delivery</code> and{" "}
        <code className="text-xs">X-Markdoc-Signature: sha256=&lt;HMAC of the body&gt;</code>; failures are retried after 10 s, 1 min and 10 min, and a hook is disabled after 20 in a row.
      </p>

      {adding && (
        <form
          className="m-5 flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4"
          data-testid="webhook-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            URL
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/markdoc" data-testid="webhook-url" required />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            <legend className="mb-1">Events</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {EVENT_CHOICES.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 font-mono text-xs text-ink-2">
                  <input
                    type="checkbox"
                    checked={choices.includes(c.id)}
                    onChange={(e) => setChoices((cur) => (e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id)))}
                    data-testid={`webhook-event-${c.id}`}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            Only these documents (optional: ids or links, comma or space separated)
            <input className="input" value={docs} onChange={(e) => setDocs(e.target.value)} placeholder="Leave empty for every document you can see" data-testid="webhook-docs" />
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm gap-1.5" disabled={busy || !url.trim() || choices.length === 0} data-testid="webhook-create">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add webhook
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <div className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">{error}</div>}

      {created && (
        <div className="m-5 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40" data-testid="webhook-created">
          <div className="mb-2 text-sm font-medium text-green-900 dark:text-green-200">Webhook added. Copy the signing secret now; it will not be shown again.</div>
          <SecretField value={created.secret} />
          <p className="mt-2 text-xs text-ink-3">
            Verify each delivery with <code>HMAC-SHA256(secret, raw body)</code> against <code>X-Markdoc-Signature</code>. Press <em>Send test</em> below to see a delivery land.
          </p>
        </div>
      )}

      {hooks === null ? (
        <div className="px-5 py-6 text-sm text-ink-3">Loading…</div>
      ) : hooks.length === 0 ? (
        <div className="px-5 py-6 text-sm text-ink-3" data-testid="webhooks-empty">
          No webhooks yet.
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {hooks.map((h) => {
            const status = deliveryLabel(h);
            return (
              <li key={h.id} className="flex items-center gap-4 px-5 py-3" data-testid="webhook-row">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-ink">{h.url}</div>
                  <div className="truncate text-xs text-ink-3">
                    {h.events.join(", ")}
                    {h.documentIds ? ` · ${h.documentIds.length} document${h.documentIds.length === 1 ? "" : "s"}` : " · all documents"} · added {relativeTime(h.createdAt)}
                  </div>
                </div>
                <div className={`shrink-0 text-xs ${status.tone === "ok" ? "text-success" : status.tone === "bad" ? "text-danger" : "text-ink-3"}`} data-testid="webhook-status">
                  {status.text}
                </div>
                <button type="button" className="btn btn-outline btn-sm gap-1.5" onClick={() => void test(h)} disabled={testing === h.id} data-testid="webhook-test">
                  {testing === h.id ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test
                </button>
                <button type="button" className="icon-btn h-8 w-8 text-ink-3 hover:text-danger" onClick={() => void remove(h)} aria-label={`Delete webhook ${h.url}`} data-testid="webhook-delete">
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
