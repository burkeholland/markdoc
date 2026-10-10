"use client";

import { useEffect, useId, useLayoutEffect, useState } from "react";
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
  | { kind: "enable"; serial: number; destination: DestinationSnapshot };
type Problem = { status: "failed" | "conflict"; message: string; source: Action["kind"] | "destination" };
type AuthorityStamp = { mount: symbol; serial: number; visibilityGeneration: number };
type RequestOwner = AuthorityStamp & { token: symbol; kind: Action["kind"] };
type TimerOwner = AuthorityStamp & { token: symbol };
class ControlAuthority {
  identity: string;
  mount: symbol | null;
  visible: boolean;
  visibilityGeneration: number;
  serial: number;
  busy: Action["kind"] | null;
  requestOwner: RequestOwner | null;
  queuedStatus: AuthorityStamp | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  timerOwner: TimerOwner | null;
  runQueuedStatus: (() => void) | null;

  constructor(identity: string) {
    this.identity = identity;
    this.mount = null;
    this.visible = false;
    this.visibilityGeneration = 0;
    this.serial = 0;
    this.busy = "status";
    this.requestOwner = null;
    this.queuedStatus = null;
    this.timer = undefined;
    this.timerOwner = null;
    this.runQueuedStatus = null;
  }
}

class ControlAuthorityCell {
  #current: ControlAuthority;

  constructor(current: ControlAuthority) {
    this.#current = current;
  }

  readonly read = () => this.#current;
}

type DestinationSnapshot = Readonly<{
  gistId: string;
  filename: string;
  url: string;
  visibility: GistAutoUpdateDestination["visibility"];
  owner: string;
}>;

const LABELS = { off: "Off", pending: "Pending", syncing: "Syncing", synced: "Synced", failed: "Failed", conflict: "Conflict" };

function snapshotDestination(destination: Readonly<GistAutoUpdateDestination>): DestinationSnapshot {
  return Object.freeze({
    gistId: destination.gistId,
    filename: destination.filename,
    url: destination.url,
    visibility: destination.visibility,
    owner: destination.owner,
  });
}

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
  const [settingsMount] = useState(() => Symbol(identity));
  const [authority] = useState(() => new ControlAuthorityCell(new ControlAuthority(identity)));
  const [action, setAction] = useState<Action>({ kind: "status", serial: 0, explicit: false });
  const [busy, setBusy] = useState<Action["kind"] | null>("status");
  const [status, setStatus] = useState<GistAutoUpdateStatus | null>(null);
  const [preview, setPreview] = useState<GistAutoUpdateDestination | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  useLayoutEffect(() => {
    const current = authority.read();
    const mount = settingsMount;
    current.mount = mount;
    current.visible = document.visibilityState === "visible";

    const onVisibilityChange = () => {
      if (current.identity !== identity || current.mount !== mount) return;
      const visible = document.visibilityState === "visible";
      if (visible === current.visible) return;
      current.visible = visible;
      current.visibilityGeneration++;
      current.queuedStatus = null;
      clearAuthorityTimer(current);
      if (!visible) return;
      current.queuedStatus = {
        mount,
        serial: current.serial,
        visibilityGeneration: current.visibilityGeneration,
      };
      current.runQueuedStatus?.();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (current.identity !== identity || current.mount !== mount) return;
      current.mount = null;
      current.visibilityGeneration++;
      current.requestOwner = null;
      current.queuedStatus = null;
      current.runQueuedStatus = null;
      clearAuthorityTimer(current);
    };
  }, [authority, identity, settingsMount]);

  useEffect(() => {
    const current = authority.read();
    let statusInFlight = false;
    const stampIsCurrent = (stamp: AuthorityStamp, requireVisible = true) => {
      return current.identity === identity
        && current.mount === stamp.mount
        && current.serial === stamp.serial
        && current.visibilityGeneration === stamp.visibilityGeneration
        && (!requireVisible || current.visible);
    };
    const owns = (owner: RequestOwner) => {
      return current.requestOwner === owner && stampIsCurrent(owner);
    };
    const claim = (kind: Action["kind"], requireVisible: boolean) => {
      const mount = current.mount;
      if (
        current.identity !== identity
        || mount === null
        || current.serial !== action.serial
        || (requireVisible && !current.visible)
      ) return null;
      const owner: RequestOwner = {
        mount,
        serial: action.serial,
        visibilityGeneration: current.visibilityGeneration,
        token: Symbol(kind),
        kind,
      };
      current.requestOwner = owner;
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
      if (current.queuedStatus && stampIsCurrent(current.queuedStatus)) return;
      clearAuthorityTimer(current);
      const timerOwner: TimerOwner = {
        mount: owner.mount,
        serial: owner.serial,
        visibilityGeneration: owner.visibilityGeneration,
        token: Symbol("timer"),
      };
      current.timerOwner = timerOwner;
      current.timer = setTimeout(() => {
        if (current.timerOwner !== timerOwner) return;
        current.timer = undefined;
        current.timerOwner = null;
        if (!stampIsCurrent(timerOwner)) return;
        current.queuedStatus = {
          mount: timerOwner.mount,
          serial: timerOwner.serial,
          visibilityGeneration: timerOwner.visibilityGeneration,
        };
        current.runQueuedStatus?.();
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
      const mount = current.mount;
      if (
        current.identity !== identity
        || mount === null
        || current.serial !== action.serial
        || !current.visible
      ) return;
      current.queuedStatus = {
        mount,
        serial: action.serial,
        visibilityGeneration: current.visibilityGeneration,
      };
      requestQueuedStatus();
    }

    function requestQueuedStatus() {
      const queued = current.queuedStatus;
      if (!queued || queued.serial !== action.serial || !stampIsCurrent(queued)) return;
      const currentOwner = current.requestOwner;
      if (currentOwner && currentOwner.mount === queued.mount && currentOwner.serial === queued.serial) return;
      current.queuedStatus = null;
      void poll();
    }

    function finish(owner: RequestOwner) {
      const ownsPhysicalRequest = current.identity === identity
        && current.mount === owner.mount
        && current.serial === owner.serial
        && current.requestOwner === owner;
      if (!ownsPhysicalRequest) return;
      const ownsCurrentGeneration = current.visible
        && current.visibilityGeneration === owner.visibilityGeneration;
      current.requestOwner = null;
      if (ownsCurrentGeneration && current.busy !== null) {
        current.busy = null;
        setBusy(null);
      }
      requestQueuedStatus();
    }

    async function poll() {
      if (statusInFlight) {
        queueStatus();
        return;
      }
      const currentOwner = current.requestOwner;
      if (
        currentOwner
        && currentOwner.mount === current.mount
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

    current.runQueuedStatus = requestQueuedStatus;
    const queued = current.queuedStatus;
    if (action.kind === "status" && queued?.serial === action.serial && stampIsCurrent(queued)) {
      current.queuedStatus = null;
    }
    void run();
    return () => {
      if (current.runQueuedStatus === requestQueuedStatus) current.runQueuedStatus = null;
    };
  }, [
    action,
    authority,
    documentId,
    filename,
    gistId,
    identity,
  ]);

  const enabled = status?.enabled ?? false;
  const state = problem?.status ?? status?.status;
  const blocked = problem?.source === "destination";
  const canRetry = enabled && !blocked && (status?.status === "failed" || status?.status === "conflict" || problem?.source === "retry");

  // One request at a time. The authority's `busy` is set here, before React renders again, so the second
  // click of a double-click (or a second button in the same task) starts nothing.
  const start = (kind: Action["kind"]) => {
    const current = authority.read();
    const mount = current.mount;
    if (
      mount !== settingsMount
      || current.busy !== null
      || (kind === "enable" && (!preview || !acknowledged || enabled))
    ) return;

    current.busy = kind;
    const queued = current.queuedStatus;
    const preserveQueuedStatus = queued
      && queued.mount === mount
      && queued.serial === current.serial
      && queued.visibilityGeneration === current.visibilityGeneration;
    const nextSerial = ++current.serial;
    clearAuthorityTimer(current);
    current.queuedStatus = preserveQueuedStatus
      ? { mount, serial: nextSerial, visibilityGeneration: current.visibilityGeneration }
      : null;
    setBusy(kind);
    setProblem(null);
    if (kind === "preview") {
      setPreview(null);
      setAcknowledged(false);
    }
    // Enable sends the destination the owner reviewed: a copy taken at the click.
    setAction(kind === "enable"
      ? { kind, serial: nextSerial, destination: snapshotDestination(preview!) }
      : kind === "status"
        ? { kind, serial: nextSerial, explicit: true }
        : { kind, serial: nextSerial });
  };
  const acknowledge = (checked: boolean) => {
    const current = authority.read();
    if (current.mount !== settingsMount || current.busy !== null) return;
    setAcknowledged(checked);
  };

  const destination = enabled ? status?.destination : preview;
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
        {status?.message && <p className="max-w-full wrap-anywhere">{status.message}</p>}
      </div>
      {problem && <p role="alert" className="max-w-full wrap-anywhere text-xs text-ink-2">{LABELS[problem.status]}: {problem.message}</p>}
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
              <input type="checkbox" checked={acknowledged} disabled={!!busy} aria-describedby={`${id}-notice ${id}-destination`} onChange={(event) => acknowledge(event.currentTarget.checked)} />
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
