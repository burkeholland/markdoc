"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, Copy, Loader2, Plus, Power, RefreshCw, Send, Trash2, Webhook } from "lucide-react";
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

type RowOperationKind = "test" | "enable" | "delete";

interface CreatedWebhook {
  id: string;
  secret: string;
  url: string;
}

type DeliveryTone = "ok" | "bad" | "muted";
type ListIntent = "refresh" | "retry";

const EVENT_CHOICES = Object.freeze([
  Object.freeze({ id: "request.created", label: "request.created", types: Object.freeze(["request.created"]) }),
  Object.freeze({ id: "mention", label: "mention", types: Object.freeze(["mention"]) }),
  Object.freeze({ id: "comment.added", label: "comment.added", types: Object.freeze(["comment.added"]) }),
  Object.freeze({ id: "comment.replied", label: "comment.replied", types: Object.freeze(["comment.replied"]) }),
  Object.freeze({ id: "review.created", label: "review.created", types: Object.freeze(["review.created"]) }),
  Object.freeze({ id: "suggestion", label: "suggestion.accepted/rejected", types: Object.freeze(["suggestion.accepted", "suggestion.rejected"]) }),
  Object.freeze({ id: "content.changed", label: "content.changed", types: Object.freeze(["content.changed"]) }),
]);
const DEFAULT_CHOICES = Object.freeze(["request.created", "mention", "comment.added", "comment.replied"]);

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

function deliveryLabel(h: WebhookRow): { text: string; tone: DeliveryTone } {
  if (!h.active) return { text: `disabled after ${h.failures} failures`, tone: "bad" };
  if (!h.lastDelivery) return { text: "no deliveries yet", tone: "muted" };
  const d = h.lastDelivery;
  const ok = d.status >= 200 && d.status < 300;
  if (ok) return { text: `${d.status} · ${relativeTime(d.at)}`, tone: "ok" };
  if (h.failures === 0) return { text: `enabled · last attempt ${d.status || "no response"} · ${relativeTime(d.at)}`, tone: "muted" };
  return { text: `failed ×${h.failures}${d.status ? ` · ${d.status}` : " · no response"} · ${relativeTime(d.at)}`, tone: "bad" };
}


function rowDetails(h: WebhookRow): string {
  const docs = h.documentIds
    ? ` · ${h.documentIds.length} document${h.documentIds.length === 1 ? "" : "s"}`
    : " · all documents";
  return `${h.events.join(", ")}${docs} · added ${relativeTime(h.createdAt)}`;
}

const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]);

/**
 * Arrow keys, Home and End move focus between the enabled buttons in `group` (a row's actions, or the
 * create form's Add/Cancel pair), without wrapping. Returns whether focus moved.
 */
function moveFocusWithin(event: ReactKeyboardEvent, controls: readonly HTMLButtonElement[]): boolean {
  if (!NAVIGATION_KEYS.has(event.key)) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return false;
  const enabled = controls.filter((control) => !control.disabled);
  const source = enabled.indexOf(event.target as HTMLButtonElement);
  if (source < 0) return false;
  let destination: number | null = null;
  if ((event.key === "ArrowLeft" || event.key === "ArrowUp") && source > 0) destination = source - 1;
  else if ((event.key === "ArrowRight" || event.key === "ArrowDown") && source + 1 < enabled.length) destination = source + 1;
  else if (event.key === "Home" && source !== 0) destination = 0;
  else if (event.key === "End" && source !== enabled.length - 1) destination = enabled.length - 1;
  if (destination === null) return false;
  event.preventDefault();
  enabled[destination]!.focus({ preventScroll: true });
  return true;
}

export function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<string[]>(() => [...DEFAULT_CHOICES]);
  const [docs, setDocs] = useState("");
  const [creating, setCreating] = useState(false);
  const [rowOperations, setRowOperations] = useState<ReadonlyMap<string, RowOperationKind>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listIntent, setListIntent] = useState<ListIntent | null>(null);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const mounted = useRef(false);
  // Every list load bumps this; a response that is not the latest request is dropped.
  const listRequest = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const creatingRef = useRef(false);
  const rowOwners = useRef(new Map<string, number>());
  // Only the latest create or row action may report an error.
  const feedbackOwner = useRef(0);
  const operationSequence = useRef(0);
  const secretTarget = useRef<HTMLElement>(null);
  const formControls = useRef<{ create: HTMLButtonElement | null; cancel: HTMLButtonElement | null }>({ create: null, cancel: null });
  const { copy: copySecret, label: copyLabel, copied } = useCopy(created?.secret ?? "", secretTarget);

  const cancelListOperation = useCallback(() => {
    listAbort.current?.abort();
    listAbort.current = null;
    listRequest.current += 1;
    setListIntent(null);
  }, []);

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    if (!mounted.current) return;
    const currentRequest = ++listRequest.current;
    const fresh = () => mounted.current && currentRequest === listRequest.current && isCurrent();
    try {
      const res = await request<{ webhooks: WebhookRow[] }>("/api/webhooks");
      if (!fresh()) return;
      setHooks(res.webhooks);
      setListError(null);
    } catch (e) {
      if (!fresh()) return;
      setListError(apiErrorText(e, "Failed to load webhooks"));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const rows = rowOwners.current;
    void load();
    return () => {
      mounted.current = false;
      listAbort.current?.abort();
      listAbort.current = null;
      listRequest.current += 1;
      creatingRef.current = false;
      rows.clear();
    };
  }, [load]);

  const claimFeedback = () => {
    const sequence = ++operationSequence.current;
    feedbackOwner.current = sequence;
    setError(null);
    return sequence;
  };

  const reportError = (sequence: number, message: string) => {
    if (mounted.current && feedbackOwner.current === sequence) setError(message);
  };

  const startList = async (intent: ListIntent) => {
    if (listAbort.current || creatingRef.current || rowOwners.current.size > 0) return;
    const controller = new AbortController();
    listAbort.current = controller;
    const currentRequest = ++listRequest.current;
    setListIntent(intent);
    const owns = () => mounted.current && listAbort.current === controller && currentRequest === listRequest.current;
    try {
      const res = await request<{ webhooks: WebhookRow[] }>("/api/webhooks", { signal: controller.signal });
      if (!owns()) return;
      setHooks(res.webhooks);
      setListError(null);
    } catch (e) {
      if (!owns()) return;
      setListError(apiErrorText(e, "Failed to load webhooks"));
    } finally {
      if (owns()) {
        listAbort.current = null;
        setListIntent(null);
      }
    }
  };

  const startCreate = async () => {
    if (creatingRef.current || !url.trim() || choices.length === 0) return;
    creatingRef.current = true;
    const sequence = claimFeedback();
    setCreating(true);
    cancelListOperation();
    const events = EVENT_CHOICES.filter((choice) => choices.includes(choice.id)).flatMap((choice) => [...choice.types]);
    const documentIds = docs
      .split(/[\s,]+/)
      .map((value) => value.trim().replace(/^.*\/d\//, ""))
      .filter(Boolean);
    const isCurrent = () => mounted.current && creatingRef.current && operationSequence.current >= sequence;
    try {
      const res = await request<{ webhook: WebhookRow & { secret: string } }>("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, events, documentIds: documentIds.length ? documentIds : null }),
      });
      if (!isCurrent()) return;
      setCreated({ id: res.webhook.id, secret: res.webhook.secret, url: res.webhook.url });
      setUrl("");
      setDocs("");
      setAdding(false);
      cancelListOperation();
      await load(isCurrent);
    } catch (e) {
      if (isCurrent()) reportError(sequence, apiErrorText(e, "Could not add webhook"));
    } finally {
      if (mounted.current) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  };

  const runRowOperation = async (
    row: WebhookRow,
    kind: RowOperationKind,
    run: () => Promise<unknown>,
    failure: string,
    onSuccess?: () => void,
  ) => {
    if (rowOwners.current.has(row.id)) return;
    const sequence = claimFeedback();
    rowOwners.current.set(row.id, sequence);
    setRowOperations((current) => new Map(current).set(row.id, kind));
    cancelListOperation();
    const isCurrent = () => mounted.current && rowOwners.current.get(row.id) === sequence;
    try {
      await run();
      if (!isCurrent()) return;
      onSuccess?.();
      cancelListOperation();
      await load(isCurrent);
    } catch (e) {
      if (isCurrent()) reportError(sequence, apiErrorText(e, failure));
    } finally {
      if (isCurrent()) {
        rowOwners.current.delete(row.id);
        setRowOperations((current) => {
          const next = new Map(current);
          next.delete(row.id);
          return next;
        });
      }
    }
  };

  const busy = creating || rowOperations.size > 0 || listIntent !== null;
  const refreshEligible = (hooks !== null || listError !== null) && !busy;
  const createEligible = !creating && url.trim().length > 0 && choices.length > 0;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!createEligible) return;
    void startCreate();
  };

  const onFormKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    const { create, cancel } = formControls.current;
    if (moveFocusWithin(event, [create, cancel].filter((control): control is HTMLButtonElement => !!control))) return;
    if (event.key === "Escape" && !creating) {
      event.preventDefault();
      setAdding(false);
    }
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>) => {
    moveFocusWithin(event, Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")));
  };

  return (
    <div className="rounded-2xl border border-line bg-surface" id="webhooks" data-testid="webhooks-card">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink">
        <Webhook size={16} className="text-ink-3" /> Webhooks
        <button
          type="button"
          className="btn btn-outline btn-sm ml-auto gap-1.5"
          onClick={() => void startList("refresh")}
          disabled={!refreshEligible}
          aria-busy={listIntent === "refresh" || undefined}
          data-testid="webhook-refresh"
        >
          <RefreshCw size={14} className={listIntent === "refresh" ? "animate-spin" : undefined} />
          {listIntent === "refresh" ? "Refreshing webhooks" : "Refresh webhooks"}
        </button>
        <button
          type="button"
          className="btn btn-outline btn-sm gap-1.5"
          onClick={() => setAdding(!adding)}
          disabled={creating}
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
          tabIndex={-1}
          aria-busy={creating || undefined}
          onKeyDown={onFormKeyDown}
          onSubmit={onSubmit}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            URL
            <input
              className="input"
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="https://example.com/markdoc"
              data-testid="webhook-url"
              disabled={creating}
              required
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs font-medium text-ink-3" disabled={creating}>
            <legend className="mb-1">Events</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {EVENT_CHOICES.map((choice) => (
                <label key={choice.id} className="flex min-h-6 items-center gap-1.5 font-mono text-xs text-ink-2">
                  <input
                    type="checkbox"
                    checked={choices.includes(choice.id)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setChoices((current) =>
                        checked
                          ? current.includes(choice.id) ? current : [...current, choice.id]
                          : current.filter((id) => id !== choice.id),
                      );
                    }}
                    data-testid={`webhook-event-${choice.id}`}
                  />
                  {choice.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            Only these documents (optional: ids or links, comma or space separated)
            <input
              className="input"
              value={docs}
              onChange={(event) => setDocs(event.currentTarget.value)}
              placeholder="Leave empty for every document you can see"
              data-testid="webhook-docs"
              disabled={creating}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              ref={(element) => {
                formControls.current.create = element;
              }}
              type="submit"
              className="btn btn-primary btn-sm gap-1.5"
              disabled={!createEligible}
              data-testid="webhook-create"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add webhook
            </button>
            <button
              ref={(element) => {
                formControls.current.cancel = element;
              }}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setAdding(false)}
              disabled={creating}
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
          <span className="min-w-0 flex-1 wrap-anywhere" role="alert" aria-atomic="true">
            {listError}
          </span>
          <button
            type="button"
            className="btn btn-outline btn-sm shrink-0 gap-1.5"
            onClick={() => void startList("retry")}
            disabled={busy}
            aria-busy={listIntent === "retry" || undefined}
          >
            {listIntent === "retry" && <Loader2 size={14} className="animate-spin" />}
            {listIntent === "retry" ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {error && (
        <div
          className="mx-5 mt-3 wrap-anywhere rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
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
          <div className="flex items-center gap-2">
            <code
              ref={secretTarget}
              className="min-w-0 flex-1 select-text break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink"
              data-testid="webhook-secret"
            >
              {created.secret}
            </code>
            <button type="button" className="btn btn-outline btn-sm shrink-0 gap-1.5" onClick={() => copySecret()} aria-label="Copy secret">
              {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
              {copyLabel}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Verify each delivery with <code>HMAC-SHA256(secret, raw body)</code> against <code>X-Markdoc-Signature</code>. Press <em>Send test</em> below to see a delivery land.
          </p>
        </div>
      )}

      {hooks === null ? (
        listError ? null : <div className="px-5 py-6 text-sm text-ink-3">Loading…</div>
      ) : hooks.length === 0 ? (
        <div className="px-5 py-6 text-sm text-ink-3" data-testid="webhooks-empty">
          No webhooks yet.
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {hooks.map((row) => {
            const operation = rowOperations.get(row.id);
            const eligible = operation === undefined;
            const details = rowDetails(row);
            const status = deliveryLabel(row);
            return (
              <li key={row.id} className="flex items-center gap-4 px-5 py-3" data-testid="webhook-row" onKeyDown={onRowKeyDown}>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-ink" title={row.url}>{row.url}</div>
                  <div className="truncate text-xs text-ink-3" title={details}>{details}</div>
                </div>
                <div
                  className={`shrink-0 text-xs ${status.tone === "ok" ? "text-success" : status.tone === "bad" ? "text-danger" : "text-ink-3"}`}
                  data-testid="webhook-status"
                >
                  {status.text}
                </div>
                {!row.active && (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm gap-1.5"
                    onClick={() =>
                      void runRowOperation(
                        row,
                        "enable",
                        () => request<{ webhook: WebhookRow }>(`/api/webhooks/${row.id}/enable`, { method: "POST" }),
                        "Could not enable webhook",
                      )
                    }
                    disabled={!eligible}
                    data-testid="webhook-enable"
                  >
                    {operation === "enable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} Enable
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-outline btn-sm gap-1.5"
                  onClick={() =>
                    void runRowOperation(
                      row,
                      "test",
                      () => request(`/api/webhooks/${row.id}/test`, { method: "POST" }),
                      "Test failed",
                    )
                  }
                  disabled={!eligible}
                  data-testid="webhook-test"
                >
                  {operation === "test" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test
                </button>
                <button
                  type="button"
                  className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                  onClick={() => {
                    if (!confirm(`Delete the webhook to ${row.url}?`)) return;
                    void runRowOperation(
                      row,
                      "delete",
                      () => request(`/api/webhooks/${row.id}`, { method: "DELETE" }),
                      "Could not delete webhook",
                      () => setCreated((current) => (current?.id === row.id ? null : current)),
                    );
                  }}
                  disabled={!eligible}
                  aria-label={`Delete webhook ${row.url}`}
                  data-testid="webhook-delete"
                >
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
