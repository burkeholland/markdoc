"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { DocumentDto } from "@/server/dto";
import { api, ApiError, apiErrorText } from "@/lib/api";
import {
  GIST_AUTO_UPDATE_NOTICE,
  type GistAutoUpdateDestination,
  type GistAutoUpdateStatus,
} from "@/lib/gist-auto-update";

type Action =
  | { kind: "status"; serial: number; explicit: boolean }
  | { kind: "preview" | "disable" | "retry"; serial: number }
  | { kind: "enable"; serial: number; destination: GistAutoUpdateDestination };
type Problem = { status: "failed" | "conflict"; message: string; source: Action["kind"] | "destination" };
type AuthorityStamp = { mount: symbol; serial: number; visibilityGeneration: number };
type RequestOwner = AuthorityStamp & { token: symbol; kind: Action["kind"] };
type TimerOwner = AuthorityStamp & { token: symbol };
type ControlAuthority = {
  identity: string;
  mount: symbol | null;
  visible: boolean;
  visibilityGeneration: number;
  busy: Action["kind"] | null;
  requestOwner: RequestOwner | null;
  queuedStatus: AuthorityStamp | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  timerOwner: TimerOwner | null;
  runQueuedStatus: (() => void) | null;
};

const LABELS = { off: "Off", pending: "Pending", syncing: "Syncing", synced: "Synced", failed: "Failed", conflict: "Conflict" };

function clearAuthorityTimer(authority: ControlAuthority) {
  if (authority.timer !== undefined) clearTimeout(authority.timer);
  authority.timer = undefined;
  authority.timerOwner = null;
}

export function GistAutoUpdateControl({ doc, isOwner }: { doc: DocumentDto; isOwner: boolean }) {
  if (!isOwner || doc.storage !== "gist" || !doc.gistId || !doc.gistFile || !doc.githubUrl || !doc.publishedAt) return null;
  const identity = JSON.stringify([doc.id, doc.gistId, doc.gistFile, doc.githubUrl, doc.ownerId]);
  return (
    <AutoUpdateSettings
      key={identity}
      identity={identity}
      documentId={doc.id}
      gistId={doc.gistId}
      filename={doc.gistFile}
      url={doc.githubUrl}
    />
  );
}

function AutoUpdateSettings({ identity, documentId, gistId, filename, url }: {
  identity: string;
  documentId: string;
  gistId: string;
  filename: string;
  url: string;
}) {
  const id = useId();
  const serial = useRef(0);
  const authorityRef = useRef<ControlAuthority>({
    identity,
    mount: null,
    visible: false,
    visibilityGeneration: 0,
    busy: "status",
    requestOwner: null,
    queuedStatus: null,
    timer: undefined,
    timerOwner: null,
    runQueuedStatus: null,
  });
  const [action, setAction] = useState<Action>({ kind: "status", serial: 0, explicit: false });
  const [busy, setBusy] = useState<Action["kind"] | null>("status");
  const [status, setStatus] = useState<GistAutoUpdateStatus | null>(null);
  const [preview, setPreview] = useState<GistAutoUpdateDestination | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  useLayoutEffect(() => {
    const authority = authorityRef.current;
    const mount = Symbol(identity);
    authority.mount = mount;
    authority.visible = document.visibilityState === "visible";

    const onVisibilityChange = () => {
      if (authority.identity !== identity || authority.mount !== mount) return;
      const visible = document.visibilityState === "visible";
      if (visible === authority.visible) return;
      authority.visible = visible;
      authority.visibilityGeneration++;
      authority.queuedStatus = null;
      clearAuthorityTimer(authority);
      if (!visible) return;
      authority.queuedStatus = {
        mount,
        serial: serial.current,
        visibilityGeneration: authority.visibilityGeneration,
      };
      authority.runQueuedStatus?.();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (authority.identity !== identity || authority.mount !== mount) return;
      authority.mount = null;
      authority.visibilityGeneration++;
      authority.requestOwner = null;
      authority.queuedStatus = null;
      authority.runQueuedStatus = null;
      clearAuthorityTimer(authority);
    };
  }, [identity]);

  useEffect(() => {
    const authority = authorityRef.current;
    let statusInFlight = false;
    const stampIsCurrent = (stamp: AuthorityStamp, requireVisible = true) => {
      return authority.identity === identity
        && authority.mount === stamp.mount
        && serial.current === stamp.serial
        && authority.visibilityGeneration === stamp.visibilityGeneration
        && (!requireVisible || authority.visible);
    };
    const owns = (owner: RequestOwner) => {
      return authority.requestOwner === owner && stampIsCurrent(owner);
    };
    const claim = (kind: Action["kind"], requireVisible: boolean) => {
      const mount = authority.mount;
      if (
        authority.identity !== identity
        || mount === null
        || serial.current !== action.serial
        || (requireVisible && !authority.visible)
      ) return null;
      const owner: RequestOwner = {
        mount,
        serial: action.serial,
        visibilityGeneration: authority.visibilityGeneration,
        token: Symbol(kind),
        kind,
      };
      authority.requestOwner = owner;
      return owner;
    };
    const matches = (owner: RequestOwner, destination: GistAutoUpdateDestination | null) => {
      if (!owns(owner)) return false;
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
    const fail = (owner: RequestOwner, error: unknown, source: Action["kind"]) => {
      if (!owns(owner)) return;
      setProblem({
        status: error instanceof ApiError && error.body?.status === "conflict" ? "conflict" : "failed",
        source,
        message: apiErrorText(error, "Could not update gist auto-update controls. Check the status before trying again."),
      });
    };
    const schedule = (owner: RequestOwner) => {
      if (!owns(owner)) return;
      if (authority.queuedStatus && stampIsCurrent(authority.queuedStatus)) return;
      clearAuthorityTimer(authority);
      const timerOwner: TimerOwner = {
        mount: owner.mount,
        serial: owner.serial,
        visibilityGeneration: owner.visibilityGeneration,
        token: Symbol("timer"),
      };
      authority.timerOwner = timerOwner;
      authority.timer = setTimeout(() => {
        if (authority.timerOwner !== timerOwner) return;
        authority.timer = undefined;
        authority.timerOwner = null;
        if (!stampIsCurrent(timerOwner)) return;
        authority.queuedStatus = {
          mount: timerOwner.mount,
          serial: timerOwner.serial,
          visibilityGeneration: timerOwner.visibilityGeneration,
        };
        authority.runQueuedStatus?.();
      }, 2_000);
    };
    const accept = (owner: RequestOwner, next: GistAutoUpdateStatus) => {
      if (!owns(owner) || !matches(owner, next.destination)) return false;
      setStatus(next);
      if (next.enabled) {
        setPreview(null);
        setAcknowledged(false);
      }
      return next.status !== "failed" && next.status !== "conflict";
    };

    function queueStatus() {
      const mount = authority.mount;
      if (
        authority.identity !== identity
        || mount === null
        || serial.current !== action.serial
        || !authority.visible
      ) return;
      authority.queuedStatus = {
        mount,
        serial: action.serial,
        visibilityGeneration: authority.visibilityGeneration,
      };
      requestQueuedStatus();
    }

    function requestQueuedStatus() {
      const queued = authority.queuedStatus;
      if (!queued || queued.serial !== action.serial || !stampIsCurrent(queued)) return;
      const currentOwner = authority.requestOwner;
      if (currentOwner && currentOwner.mount === queued.mount && currentOwner.serial === queued.serial) return;
      authority.queuedStatus = null;
      void poll();
    }

    function finish(owner: RequestOwner) {
      const ownsPhysicalRequest = authority.identity === identity
        && authority.mount === owner.mount
        && serial.current === owner.serial
        && authority.requestOwner === owner;
      if (!ownsPhysicalRequest) return;
      const ownsCurrentGeneration = authority.visible
        && authority.visibilityGeneration === owner.visibilityGeneration;
      authority.requestOwner = null;
      if (ownsCurrentGeneration && authority.busy !== null) {
        authority.busy = null;
        setBusy(null);
      }
      requestQueuedStatus();
    }

    async function poll() {
      if (statusInFlight) {
        queueStatus();
        return;
      }
      const currentOwner = authority.requestOwner;
      if (
        currentOwner
        && currentOwner.mount === authority.mount
        && currentOwner.serial === action.serial
      ) {
        queueStatus();
        return;
      }
      const owner = claim("status", true);
      if (!owner) return;
      statusInFlight = true;
      try {
        const next = await api.documents.gistAutoUpdate(documentId);
        if (!owns(owner)) return;
        setProblem(null);
        if (accept(owner, next)) schedule(owner);
      } catch (error) {
        fail(owner, error, "status");
      } finally {
        statusInFlight = false;
        finish(owner);
      }
    }

    async function run() {
      if (action.kind === "status") return poll();
      const owner = claim(action.kind, false);
      if (!owner) return;
      try {
        if (action.kind === "preview") {
          const result = await api.documents.gistAutoUpdatePreview(documentId);
          if (!owns(owner)) return;
          if (matches(owner, result.destination)) {
            setPreview(result.destination);
            schedule(owner);
          }
        } else {
          const next = action.kind === "retry"
            ? await api.documents.retryGistAutoUpdate(documentId)
            : await api.documents.setGistAutoUpdate(documentId, action.kind === "enable"
              ? { enabled: true, acknowledgeRisk: true, destination: action.destination }
              : { enabled: false });
          if (!owns(owner)) return;
          setPreview(null);
          setAcknowledged(false);
          if (accept(owner, next)) schedule(owner);
        }
      } catch (error) {
        if (!owns(owner)) return;
        fail(owner, error, action.kind);
        if (action.kind === "enable") {
          setPreview(null);
          setAcknowledged(false);
        }
      } finally {
        finish(owner);
      }
    }

    authority.runQueuedStatus = requestQueuedStatus;
    const queued = authority.queuedStatus;
    if (action.kind === "status" && queued?.serial === action.serial && stampIsCurrent(queued)) {
      authority.queuedStatus = null;
    }
    void run();
    return () => {
      if (authority.runQueuedStatus === requestQueuedStatus) authority.runQueuedStatus = null;
    };
  }, [action, documentId, filename, gistId, identity]);

  function start(kind: Action["kind"]) {
    const authority = authorityRef.current;
    const mount = authority.mount;
    if (
      authority.identity !== identity
      || mount === null
      || authority.busy !== null
      || (kind === "enable" && (!preview || !acknowledged || status?.enabled))
    ) return;
    const queued = authority.queuedStatus;
    const preserveQueuedStatus = queued
      && queued.mount === mount
      && queued.serial === serial.current
      && queued.visibilityGeneration === authority.visibilityGeneration;
    const nextSerial = ++serial.current;
    clearAuthorityTimer(authority);
    authority.queuedStatus = preserveQueuedStatus
      ? { mount, serial: nextSerial, visibilityGeneration: authority.visibilityGeneration }
      : null;
    authority.busy = kind;
    setBusy(kind);
    setProblem(null);
    if (kind === "preview") {
      setPreview(null);
      setAcknowledged(false);
    }
    setAction(kind === "enable"
      ? { kind, serial: nextSerial, destination: preview! }
      : kind === "status"
        ? { kind, serial: nextSerial, explicit: true }
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
