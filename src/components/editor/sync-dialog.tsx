"use client";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { memo, useEffect, useState } from "react";
import { AlertTriangle, Check, CloudDownload, GitMerge, Loader2, Scale, UploadCloud } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { SyncStatusDto } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

export const SYNC_LABELS: Record<SyncStatusDto["status"], string> = {
  "in-sync": "Up to date",
  "local-ahead": "Unpublished changes",
  "remote-ahead": "GitHub has changes",
  diverged: "Both changed",
};

export interface SyncActions {
  /** pull?merge=1 — resolves to the number of conflicts left in the document (0 = clean merge). */
  merge: () => Promise<number>;
  keepMine: (message: string) => Promise<void>;
  takeRemote: () => Promise<void>;
  compare: () => void;
}

/**
 * Three-way summary for a document whose GitHub file and local text both moved. The user picks a
 * way forward: merge (conflicts land in the editor with markers), keep mine (force publish), take
 * GitHub (force pull) or look at the diff first.
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
  useEffect(() => {
    if (open) {
      setMessage(`Update ${doc.repoPath ?? doc.gistFile ?? "document"}`);
      setError(null);
      setDone(null);
      setBusy(null);
    }
  }, [open, doc.repoPath, doc.gistFile]);

  const run = async (kind: "merge" | "keep" | "take", fn: () => Promise<string>) => {
    setBusy(kind);
    setError(null);
    try {
      const note = await fn();
      setDone(note);
      setTimeout(() => onOpenChange(false), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  };

  const status = sync?.status ?? "diverged";
  const where = doc.storage === "gist" ? "the gist" : `${doc.repoOwner}/${doc.repoName} (${doc.repoBranch})`;
  const lines = sync?.lines ?? { local: 0, remote: 0 };
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Sync with GitHub" description={`This document and ${where} both changed since they were last in sync.`}>
        <div className="flex flex-col gap-4" data-testid="sync-dialog" data-status={status}>
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

          <div className="flex flex-col gap-2">
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
            <button type="button" className="btn btn-outline justify-start gap-2" disabled={!!busy || !!done} data-testid="sync-keep-mine"
              onClick={() => run("keep", async () => (await actions.keepMine(message.trim()), "Published your version"))}
            >
              {busy === "keep" ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
              <span className="flex flex-col items-start">
                <span>Keep mine</span>
                <span className="text-xs font-normal text-ink-3">Force-publish this document over the GitHub file.</span>
              </span>
            </button>
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
                onOpenChange(false);
              }}
            >
              <Scale size={16} /> Compare GitHub with this document
            </button>
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
