"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Plus, Power, Send, Trash2, Webhook } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { ApiError, apiErrorText } from "@/lib/api";

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

interface Operation {
  sequence: number;
  generation: number;
}

interface RowOperation extends Operation {
  webhookId: string;
  kind: "test" | "enable" | "delete";
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
  if (!res.ok) {
    // Keep the 400's `issues` so the form can show the field's reason, not the bare "Invalid request".
    const err = (data ?? {}) as { error?: string; issues?: unknown };
    throw new ApiError(res.status, err.error ?? res.statusText, err.issues);
  }
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
  if (h.failures === 0) return { text: `enabled · last attempt ${d.status || "no response"} · ${relativeTime(d.at)}`, tone: "muted" };
  return { text: `failed ×${h.failures}${d.status ? ` · ${d.status}` : " · no response"} · ${relativeTime(d.at)}`, tone: "bad" };
}

export function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<string[]>(DEFAULT_CHOICES);
  const [docs, setDocs] = useState("");
  const [createOperation, setCreateOperation] = useState<Operation | null>(null);
  const [rowOperations, setRowOperations] = useState<Map<string, RowOperation>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [created, setCreated] = useState<{ id: string; secret: string; url: string } | null>(null);
  const mountedGeneration = useRef(0);
  const operationSequence = useRef(0);
  const createOwner = useRef<Operation | null>(null);
  const rowOwners = useRef(new Map<string, RowOperation>());
  const feedbackOwner = useRef<Operation | null>(null);
  const listRequest = useRef(0);
  const retryPending = useRef(false);

  useEffect(() => {
    const generation = ++mountedGeneration.current;
    const owners = rowOwners.current;
    return () => {
      if (mountedGeneration.current !== generation) return;
      mountedGeneration.current += 1;
      listRequest.current += 1;
      createOwner.current = null;
      owners.clear();
      feedbackOwner.current = null;
    };
  }, []);

  const load = useCallback(async (continuationIsCurrent: () => boolean = () => true) => {
    const generation = mountedGeneration.current;
    const currentRequest = ++listRequest.current;
    try {
      const res = await request<{ webhooks: WebhookRow[] }>("/api/webhooks");
      if (generation !== mountedGeneration.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setHooks(res.webhooks);
      setListError(null);
    } catch (e) {
      if (generation !== mountedGeneration.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setListError(apiErrorText(e, "Failed to load webhooks"));
    }
  }, []);

  const retry = useCallback(() => {
    if (retryPending.current) return;
    retryPending.current = true;
    const generation = mountedGeneration.current;
    setRetrying(true);
    void load().finally(() => {
      if (generation !== mountedGeneration.current) return;
      retryPending.current = false;
      setRetrying(false);
    });
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const isCreateCurrent = (operation: Operation) =>
    operation.generation === mountedGeneration.current && createOwner.current === operation;

  const isRowCurrent = (operation: RowOperation) =>
    operation.generation === mountedGeneration.current && rowOwners.current.get(operation.webhookId) === operation;

  const nextOperation = (): Operation => ({
    sequence: ++operationSequence.current,
    generation: mountedGeneration.current,
  });

  const claimFeedback = (operation: Operation) => {
    feedbackOwner.current = operation;
    setError(null);
  };

  const beginRowOperation = (webhookId: string, kind: RowOperation["kind"]): RowOperation | null => {
    if (rowOwners.current.has(webhookId)) return null;
    const operation = { ...nextOperation(), webhookId, kind };
    claimFeedback(operation);
    rowOwners.current.set(webhookId, operation);
    setRowOperations((current) => new Map(current).set(webhookId, operation));
    return operation;
  };

  const finishRowOperation = (operation: RowOperation) => {
    if (!isRowCurrent(operation)) return;
    rowOwners.current.delete(operation.webhookId);
    setRowOperations((current) => {
      if (current.get(operation.webhookId) !== operation) return current;
      const next = new Map(current);
      next.delete(operation.webhookId);
      return next;
    });
  };

  const setOperationError = (operation: Operation, message: string) => {
    if (operation.generation === mountedGeneration.current && feedbackOwner.current === operation) {
      setError(message);
    }
  };

  const add = async () => {
    if (createOwner.current) return;
    const operation = nextOperation();
    claimFeedback(operation);
    createOwner.current = operation;
    setCreateOperation(operation);
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
      if (!isCreateCurrent(operation)) return;
      setCreated({ id: res.webhook.id, secret: res.webhook.secret, url: res.webhook.url });
      setUrl("");
      setDocs("");
      setAdding(false);
      await load(() => isCreateCurrent(operation));
    } catch (e) {
      if (isCreateCurrent(operation)) {
        setOperationError(operation, apiErrorText(e, "Could not add webhook"));
      }
    } finally {
      if (isCreateCurrent(operation)) {
        createOwner.current = null;
        setCreateOperation((current) => (current === operation ? null : current));
      }
    }
  };

  const remove = async (h: WebhookRow) => {
    if (rowOwners.current.has(h.id)) return;
    if (!confirm(`Delete the webhook to ${h.url}?`)) return;
    const operation = beginRowOperation(h.id, "delete");
    if (!operation) return;
    try {
      await request(`/api/webhooks/${h.id}`, { method: "DELETE" });
      if (!isRowCurrent(operation)) return;
      setCreated((current) => (current?.id === h.id ? null : current));
      await load(() => isRowCurrent(operation));
    } catch (e) {
      if (isRowCurrent(operation)) {
        setOperationError(operation, apiErrorText(e, "Could not delete webhook"));
      }
    } finally {
      finishRowOperation(operation);
    }
  };

  const test = async (h: WebhookRow) => {
    const operation = beginRowOperation(h.id, "test");
    if (!operation) return;
    try {
      await request(`/api/webhooks/${h.id}/test`, { method: "POST" });
      if (!isRowCurrent(operation)) return;
      await load(() => isRowCurrent(operation));
    } catch (e) {
      if (isRowCurrent(operation)) {
        setOperationError(operation, apiErrorText(e, "Test failed"));
      }
    } finally {
      finishRowOperation(operation);
    }
  };

  const enable = async (h: WebhookRow) => {
    const operation = beginRowOperation(h.id, "enable");
    if (!operation) return;
    try {
      await request<{ webhook: WebhookRow }>(`/api/webhooks/${h.id}/enable`, { method: "POST" });
      if (!isRowCurrent(operation)) return;
      await load(() => isRowCurrent(operation));
    } catch (e) {
      if (isRowCurrent(operation)) {
        setOperationError(operation, apiErrorText(e, "Could not enable webhook"));
      }
    } finally {
      finishRowOperation(operation);
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-surface" id="webhooks" data-testid="webhooks-card">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink">
        <Webhook size={16} className="text-ink-3" /> Webhooks
        <button
          type="button"
          className="btn btn-outline btn-sm ml-auto gap-1.5"
          onClick={() => {
            if (!createOwner.current) setAdding((v) => !v);
          }}
          disabled={createOperation !== null}
          data-testid="webhook-add"
        >
          <Plus size={14} /> Add webhook
        </button>
      </div>
      <p className="px-5 pt-3 text-sm leading-6 text-ink-3">
        Push the events <code className="text-xs">markdoc_watch</code> returns to an HTTP endpoint instead of long-polling: a GitHub Actions job, a bot, a Slack bridge. Each
        delivery is a JSON <code className="text-xs">POST</code> with <code className="text-xs">X-Markdoc-Event</code>, <code className="text-xs">X-Markdoc-Delivery</code> and{" "}
        <code className="text-xs">X-Markdoc-Signature: sha256=&lt;HMAC of the body&gt;</code>; failures are retried after 10 s, 1 min and 10 min, and a hook is disabled after 20 in a row. After fixing the receiver, enable the same hook here without changing its signing secret.
      </p>

      {adding && (
        <form
          className="m-5 flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4"
          data-testid="webhook-form"
          aria-busy={createOperation !== null || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            URL
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/markdoc"
              data-testid="webhook-url"
              disabled={createOperation !== null}
              required
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs font-medium text-ink-3" disabled={createOperation !== null}>
            <legend className="mb-1">Events</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {EVENT_CHOICES.map((c) => (
                <label key={c.id} className="flex min-h-6 items-center gap-1.5 font-mono text-xs text-ink-2">
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
            <input
              className="input"
              value={docs}
              onChange={(e) => setDocs(e.target.value)}
              placeholder="Leave empty for every document you can see"
              data-testid="webhook-docs"
              disabled={createOperation !== null}
            />
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm gap-1.5" disabled={createOperation !== null || !url.trim() || choices.length === 0} data-testid="webhook-create">
              {createOperation ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add webhook
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (!createOwner.current) setAdding(false);
              }}
              disabled={createOperation !== null}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {listError && (
        <div
          className="mx-5 mt-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          data-testid="webhooks-list-error"
        >
          <span className="min-w-0 flex-1" role="alert" aria-atomic="true">
            {listError}
          </span>
          <button type="button" className="btn btn-outline btn-sm shrink-0 gap-1.5" onClick={retry} disabled={retrying} aria-busy={retrying || undefined}>
            {retrying && <Loader2 size={14} className="animate-spin" />}
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {error && (
        <div
          className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          role="alert"
          aria-atomic="true"
          data-testid="webhook-action-error"
        >
          {error}
        </div>
      )}

      {created && (
        <div
          className="m-5 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="webhook-created"
        >
          <div className="mb-2 text-sm font-medium text-green-900 dark:text-green-200">Webhook added. Copy the signing secret now; it will not be shown again.</div>
          <SecretField value={created.secret} />
          <p className="mt-2 text-xs text-ink-3">
            Verify each delivery with <code>HMAC-SHA256(secret, raw body)</code> against <code>X-Markdoc-Signature</code>. Press <em>Send test</em> below to see a delivery land.
          </p>
        </div>
      )}

      {hooks === null ? (
        listError ? null : (
          <div className="px-5 py-6 text-sm text-ink-3">Loading…</div>
        )
      ) : hooks.length === 0 ? (
        <div className="px-5 py-6 text-sm text-ink-3" data-testid="webhooks-empty">
          No webhooks yet.
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {hooks.map((h) => {
            const status = deliveryLabel(h);
            const rowOperation = rowOperations.get(h.id);
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
                {!h.active && (
                  <button type="button" className="btn btn-outline btn-sm gap-1.5" onClick={() => void enable(h)} disabled={Boolean(rowOperation)} data-testid="webhook-enable">
                    {rowOperation?.kind === "enable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} Enable
                  </button>
                )}
                <button type="button" className="btn btn-outline btn-sm gap-1.5" onClick={() => void test(h)} disabled={Boolean(rowOperation)} data-testid="webhook-test">
                  {rowOperation?.kind === "test" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test
                </button>
                <button type="button" className="icon-btn h-8 w-8 text-ink-3 hover:text-danger" onClick={() => void remove(h)} disabled={Boolean(rowOperation)} aria-label={`Delete webhook ${h.url}`} data-testid="webhook-delete">
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
