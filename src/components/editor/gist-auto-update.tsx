"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DocumentDto } from "@/server/dto";
import { api, ApiError, apiErrorText } from "@/lib/api";
import {
  GIST_AUTO_UPDATE_NOTICE,
  type GistAutoUpdateDestination,
  type GistAutoUpdateStatus,
} from "@/lib/gist-auto-update";

type Action =
  | { kind: "status" | "preview" | "disable" | "retry"; serial: number }
  | { kind: "enable"; serial: number; destination: GistAutoUpdateDestination };
type Problem = { status: "failed" | "conflict"; message: string; source: Action["kind"] | "destination" };

const LABELS = { off: "Off", pending: "Pending", syncing: "Syncing", synced: "Synced", failed: "Failed", conflict: "Conflict" };

export function GistAutoUpdateControl({ doc, isOwner }: { doc: DocumentDto; isOwner: boolean }) {
  if (!isOwner || doc.storage !== "gist" || !doc.gistId || !doc.gistFile || !doc.githubUrl || !doc.publishedAt) return null;
  return (
    <AutoUpdateSettings
      key={JSON.stringify([doc.id, doc.gistId, doc.gistFile, doc.githubUrl, doc.ownerId])}
      documentId={doc.id}
      gistId={doc.gistId}
      filename={doc.gistFile}
      url={doc.githubUrl}
    />
  );
}

function AutoUpdateSettings({ documentId, gistId, filename, url }: { documentId: string; gistId: string; filename: string; url: string }) {
  const id = useId();
  const serial = useRef(0);
  const [action, setAction] = useState<Action>({ kind: "status", serial: 0 });
  const [busy, setBusy] = useState<Action["kind"] | null>("status");
  const [status, setStatus] = useState<GistAutoUpdateStatus | null>(null);
  const [preview, setPreview] = useState<GistAutoUpdateDestination | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => active && serial.current === action.serial;
    const matches = (destination: GistAutoUpdateDestination | null) => {
      if (!destination || (destination.gistId === gistId && destination.filename === filename)) return true;
      setPreview(null);
      setAcknowledged(false);
      setProblem({
        status: "conflict",
        source: "destination",
        message: "The linked gist changed. Close and reopen publishing controls to review the current destination.",
      });
      return false;
    };
    const fail = (error: unknown, source: Action["kind"]) => {
      setProblem({
        status: error instanceof ApiError && error.body?.status === "conflict" ? "conflict" : "failed",
        source,
        message: apiErrorText(error, "Could not update gist auto-update controls. Check the status before trying again."),
      });
    };
    const schedule = () => { timer = setTimeout(() => { void poll(); }, 2_000); };
    const accept = (next: GistAutoUpdateStatus) => {
      if (!matches(next.destination)) return;
      setStatus(next);
      if (next.enabled) {
        setPreview(null);
        setAcknowledged(false);
      }
      if (next.status !== "failed" && next.status !== "conflict") schedule();
    };
    async function poll() {
      if (!current()) return;
      try {
        const next = await api.documents.gistAutoUpdate(documentId);
        if (!current()) return;
        setProblem(null);
        accept(next);
      } catch (error) {
        if (current()) fail(error, "status");
      } finally {
        if (current()) setBusy(null);
      }
    }
    async function run() {
      if (action.kind === "status") return poll();
      try {
        if (action.kind === "preview") {
          const result = await api.documents.gistAutoUpdatePreview(documentId);
          if (!current()) return;
          if (matches(result.destination)) {
            setPreview(result.destination);
            schedule();
          }
        } else {
          const next = action.kind === "retry"
            ? await api.documents.retryGistAutoUpdate(documentId)
            : await api.documents.setGistAutoUpdate(documentId, action.kind === "enable"
              ? { enabled: true, acknowledgeRisk: true, destination: action.destination }
              : { enabled: false });
          if (!current()) return;
          setPreview(null);
          setAcknowledged(false);
          accept(next);
        }
      } catch (error) {
        if (!current()) return;
        fail(error, action.kind);
        if (action.kind === "enable") {
          setPreview(null);
          setAcknowledged(false);
        }
      } finally {
        if (current()) setBusy(null);
      }
    }
    void run();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [documentId, gistId, filename, action]);

  function start(kind: Action["kind"]) {
    if (busy || (kind === "enable" && (!preview || !acknowledged || status?.enabled))) return;
    // Invalidate an in-flight poll immediately, before the next effect can clean it up.
    const nextSerial = ++serial.current;
    setBusy(kind);
    setProblem(null);
    if (kind === "preview") {
      setPreview(null);
      setAcknowledged(false);
    }
    setAction(kind === "enable"
      ? { kind, serial: nextSerial, destination: preview! }
      : { kind, serial: nextSerial });
  }

  const enabled = status?.enabled ?? false;
  const state = problem?.status ?? status?.status;
  const destination = enabled ? status?.destination : preview;
  const blocked = problem?.source === "destination";
  const canRetry = enabled && !blocked && (status?.status === "failed" || status?.status === "conflict" || problem?.source === "retry");
  return (
    <section aria-labelledby={`${id}-title`} className="mb-4 flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3 text-sm" data-testid="gist-auto-update">
      <div className="flex items-center gap-2 font-medium text-ink">
        <h3 id={`${id}-title`}>Auto-update gist</h3>
        <span className="ml-auto text-xs text-ink-3" role="status" data-testid="gist-auto-update-state" data-status={state ?? "loading"}>
          {state ? LABELS[state] : "Checking status…"}
        </span>
      </div>
      <p id={`${id}-notice`} className="text-xs text-ink-3">{GIST_AUTO_UPDATE_NOTICE}</p>
      <p className="text-xs text-ink-3">This is best-effort publishing: checking GitHub and uploading are not one atomic operation.</p>
      <div id={`${id}-destination`} className="break-all text-xs text-ink-2" data-testid="gist-auto-update-destination">
        <p>Destination: <a href={destination?.url ?? url} target="_blank" rel="noopener noreferrer" className="underline">{destination?.url ?? url}</a></p>
        <p>File: {destination?.filename ?? filename}</p>
        {destination && (
          <>
            <p>Visibility: {destination.visibility === "public" ? "Public" : "Secret (unlisted, not private)"}</p>
            <p>GitHub account: @{destination.owner}</p>
          </>
        )}
      </div>
      <div role="status" aria-live="polite" className="text-xs text-ink-2">
        {status?.status === "pending" && <p>The latest saved version is waiting to publish.</p>}
        {status?.status === "syncing" && <p>Uploading a saved version to the gist.</p>}
        {status?.pending && status.status === "syncing" && <p data-testid="gist-auto-update-pending">The newest saved version is pending behind the current upload.</p>}
        {status?.syncedAt && <p>Last synced at <time dateTime={status.syncedAt}>{new Date(status.syncedAt).toLocaleString()}</time>.</p>}
        {status?.message && <p>{status.message}</p>}
      </div>
      {problem && <p role="alert" className="text-xs text-ink-2">{LABELS[problem.status]}: {problem.message}</p>}
      {problem && (problem.source === "enable" || problem.source === "disable" || problem.source === "retry") && (
        <p className="text-xs text-ink-3">Refresh status to confirm the setting and saved-version progress before trying again.</p>
      )}
      {state === "conflict" && <p className="text-xs text-ink-3">Publishing is paused for a conflict. Manually reconcile the Markdoc and GitHub versions before retrying. Retry does not force an overwrite or resolve a known conflict.</p>}
      {problem && !blocked && (
        <button type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy} onClick={() => start("status")}>Refresh status</button>
      )}
      {!enabled && (
        <>
          <p className="text-xs text-ink-3" data-testid="gist-auto-update-preview" data-status={busy === "preview" ? "checking" : preview ? "checked" : "unchecked"}>
            {busy === "preview" ? "Checking the linked gist (no publishing)…" : preview ? "Review this checked destination and acknowledge the risks before enabling." : "Check the linked gist to review its current visibility and GitHub account before enabling."}
          </p>
          <button type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy || !status || blocked} onClick={() => start("preview")}>
            {preview ? "Recheck linked gist" : "Check linked gist"}
          </button>
          {preview && (
            <label className="flex items-start gap-2 text-xs text-ink-2">
              <input type="checkbox" checked={acknowledged} disabled={!!busy} aria-describedby={`${id}-notice ${id}-destination`} onChange={(event) => setAcknowledged(event.target.checked)} />
              I acknowledge the sharing and overwrite risks.
            </label>
          )}
          <button type="button" className="btn btn-sm btn-primary self-start" disabled={!!busy || !status || !preview || !acknowledged || blocked || problem?.source === "status"} onClick={() => start("enable")}>
            {busy === "enable" ? "Enabling…" : "Enable auto-update"}
          </button>
        </>
      )}
      {canRetry && (
        <button type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy} onClick={() => start("retry")}>
          {busy === "retry" ? "Requesting retry…" : "Retry latest saved version"}
        </button>
      )}
      {enabled && (
        <button type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy} onClick={() => start("disable")}>
          {busy === "disable" ? "Disabling…" : "Disable auto-update"}
        </button>
      )}
      <p className="text-xs text-ink-3">Turning auto-update off stops future updates. An update already in progress may still finish.</p>
    </section>
  );
}
