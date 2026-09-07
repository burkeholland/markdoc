"use client";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Check, CloudDownload, GitMerge, Loader2, Scale, UploadCloud } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { apiErrorText, type SyncStatusDto } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

type SyncActionKind = "merge" | "keep" | "take";
type DialogVisit = { sequence: number; docId: string };
type ActionOwner = { visit: DialogVisit; kind: SyncActionKind };
type SuccessClose = { owner: ActionOwner; timer: ReturnType<typeof setTimeout> };

export interface SyncActions {
  /** pull?merge=1 — resolves to the number of conflicts left in the document (0 = clean merge). */
  merge: () => Promise<number>;
  keepMine: (message: string) => Promise<void>;
  takeRemote: () => Promise<void>;
  compare: () => void;
}

/**
 * Three-way summary for a document whose GitHub file and local text both moved. An oversized remote
 * file cannot be read, so only the force-publish path remains available.
 */
export const SyncDialog = memo(function SyncDialog({
  open,
  onOpenChange,
  doc,
  sync,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  sync: SyncStatusDto | null;
  actions: SyncActions;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"merge" | "keep" | "take" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const visitSequenceRef = useRef(0);
  const currentVisitRef = useRef<DialogVisit | null>(null);
  const inFlightRef = useRef<ActionOwner | null>(null);
  const successCloseRef = useRef<SuccessClose | null>(null);

  useLayoutEffect(() => {
    const previousClose = successCloseRef.current;
    if (previousClose) clearTimeout(previousClose.timer);
    successCloseRef.current = null;
    inFlightRef.current = null;

    const visit = open ? { sequence: ++visitSequenceRef.current, docId: doc.id } : null;
    currentVisitRef.current = visit;
    if (open) {
      setMessage(`Update ${doc.repoPath ?? doc.gistFile ?? "document"}`);
      setError(null);
      setDone(null);
      setBusy(null);
    }

    return () => {
      if (currentVisitRef.current === visit) currentVisitRef.current = null;
      if (visit && inFlightRef.current?.visit === visit) inFlightRef.current = null;
      const scheduledClose = successCloseRef.current;
      if (scheduledClose && (!visit || scheduledClose.owner.visit === visit)) {
        clearTimeout(scheduledClose.timer);
        successCloseRef.current = null;
      }
    };
  }, [open, doc.id, doc.repoPath, doc.gistFile]);

  const cancelSuccessClose = () => {
    const scheduledClose = successCloseRef.current;
    if (scheduledClose) clearTimeout(scheduledClose.timer);
    successCloseRef.current = null;
  };

  const invalidateCurrentVisit = () => {
    currentVisitRef.current = null;
    inFlightRef.current = null;
    cancelSuccessClose();
  };

  const ownsCurrentVisit = (owner: ActionOwner) =>
    currentVisitRef.current === owner.visit && currentVisitRef.current.docId === owner.visit.docId;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) invalidateCurrentVisit();
    onOpenChange(nextOpen);
  };

  const run = async (kind: SyncActionKind, fn: () => Promise<string>) => {
    const visit = currentVisitRef.current;
    if (!open || !visit || visit.docId !== doc.id || inFlightRef.current) return;

    const owner = { visit, kind };
    inFlightRef.current = owner;
    cancelSuccessClose();
    setBusy(kind);
    setError(null);
    setDone(null);
    try {
      const note = await fn();
      if (!ownsCurrentVisit(owner)) return;
      setDone(note);
      const timer = setTimeout(() => {
        if (successCloseRef.current?.owner !== owner || !ownsCurrentVisit(owner)) return;
        successCloseRef.current = null;
        invalidateCurrentVisit();
        onOpenChange(false);
      }, 900);
      successCloseRef.current = { owner, timer };
    } catch (e) {
      if (!ownsCurrentVisit(owner)) return;
      setError(apiErrorText(e, "Sync failed"));
    } finally {
      if (ownsCurrentVisit(owner) && inFlightRef.current === owner) {
        inFlightRef.current = null;
        setBusy(null);
      }
    }
  };

  const status = sync?.status ?? "diverged";
  const remoteUnreadable = status === "remote-unreadable";
  const where = doc.storage === "gist" ? "the gist" : `${doc.repoOwner}/${doc.repoName} (${doc.repoBranch})`;
  const lines = sync?.lines ?? { local: 0, remote: 0 };
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const formatMb = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? String(Math.ceil(mb)) : String(Math.ceil(mb * 100) / 100);
  };
  const sizeMessage =
    sync?.size != null && sync.limit != null
      ? `The GitHub file is ${formatMb(sync.size)} MB, but Markdoc can read files up to ${formatMb(sync.limit)} MB.`
      : "The GitHub file is too large for Markdoc to read.";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        title="Sync with GitHub"
        description={remoteUnreadable ? `The file in ${where} cannot be read until it is made smaller or replaced.` : `This document and ${where} both changed since they were last in sync.`}
      >
        <div className="flex flex-col gap-4" data-testid="sync-dialog" data-status={status}>
          {remoteUnreadable ? (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert" data-testid="sync-remote-unreadable">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div>{sizeMessage}</div>
                <div className="mt-1 text-xs">Merge, pull, and compare are unavailable. Keep mine will replace the GitHub file with this document.</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-3">This document</div>
                <div className="mt-1 font-medium text-ink" data-testid="sync-local-lines">
                  {sync?.localChanged ? `${plural(lines.local)} changed` : "No changes"}
                </div>
                <div className="text-xs text-ink-3">since {doc.publishedAt ? relativeTime(doc.publishedAt) : "the last sync"}</div>
              </div>
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-3">On GitHub</div>
                <div className="mt-1 font-medium text-ink" data-testid="sync-remote-lines">
                  {sync?.remoteChanged ? `${plural(lines.remote)} changed` : "No changes"}
                </div>
                <div className="truncate text-xs text-ink-3">
                  {sync?.remote.updatedAt ? `updated ${relativeTime(sync.remote.updatedAt)}` : sync?.remote.sha ? `at ${sync.remote.sha.slice(0, 7)}` : "\u00a0"}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {!remoteUnreadable && (
              <button type="button" className="btn btn-primary justify-start gap-2" disabled={!!busy || !!done} data-testid="sync-merge"
                onClick={() =>
                  run("merge", async () => {
                    const conflicts = await actions.merge();
                    return conflicts > 0 ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve in the editor` : "Merged — review, then publish";
                  })
                }
              >
                {busy === "merge" ? <Loader2 size={16} className="animate-spin" /> : <GitMerge size={16} />}
                <span className="flex flex-col items-start">
                  <span>Merge</span>
                  <span className="text-xs font-normal opacity-80">Combine both sets of edits; conflicting lines are marked for you to resolve.</span>
                </span>
              </button>
            )}
            <button type="button" className="btn btn-outline justify-start gap-2" disabled={!!busy || !!done} data-testid="sync-keep-mine"
              onClick={() => run("keep", async () => (await actions.keepMine(message.trim()), "Published your version"))}
            >
              {busy === "keep" ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
              <span className="flex flex-col items-start">
                <span>Keep mine</span>
                <span className="text-xs font-normal text-ink-3">Force-publish this document over the GitHub file.</span>
              </span>
            </button>
            {!remoteUnreadable && (
              <>
                <button type="button" className="btn btn-outline justify-start gap-2" disabled={!!busy || !!done} data-testid="sync-take-remote"
                  onClick={() => run("take", async () => (await actions.takeRemote(), "Replaced with GitHub's copy"))}
                >
                  {busy === "take" ? <Loader2 size={16} className="animate-spin" /> : <CloudDownload size={16} />}
                  <span className="flex flex-col items-start">
                    <span>Take GitHub</span>
                    <span className="text-xs font-normal text-ink-3">Force-pull; your local edits are kept in version history.</span>
                  </span>
                </button>
                <button type="button" className="btn btn-ghost justify-start gap-2" disabled={!!busy} data-testid="sync-compare"
                  onClick={() => {
                    actions.compare();
                    handleOpenChange(false);
                  }}
                >
                  <Scale size={16} /> Compare GitHub with this document
                </button>
              </>
            )}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-2">{doc.storage === "gist" ? "Description" : "Commit message"} <span className="font-normal text-ink-3">(for Keep mine)</span></span>
            <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} data-testid="commit-message" />
          </label>

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
          {done && (
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2" data-testid="sync-done">
              <Check size={14} className="text-success" /> {done}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});
