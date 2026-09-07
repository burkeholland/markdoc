"use client";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CloudDownload, GitMerge, Loader2, Scale, UploadCloud } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { apiErrorText, type SyncStatusDto } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

type SyncActionKind = "merge" | "keep" | "take";
type SyncControlKind = SyncActionKind | "compare";
interface SyncPresentation {
  mount: symbol;
  open: boolean;
  doc: DocumentDto;
  docId: string;
  storage: DocumentDto["storage"];
  repoPath: string | null;
  gistFile: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoBranch: string | null;
  publishedAt: string | null;
  sync: SyncStatusDto | null;
  syncLines: SyncStatusDto["lines"] | null;
  syncRemote: SyncStatusDto["remote"] | null;
  status: SyncStatusDto["status"];
  localChanged: boolean;
  remoteChanged: boolean;
  localLines: number;
  remoteLines: number;
  remoteUpdatedAt: string | null;
  remoteSha: string | null;
  remoteSize: number | null;
  remoteLimit: number | null;
  remoteUnreadable: boolean;
  actions: SyncActions;
  merge: SyncActions["merge"];
  keepMine: SyncActions["keepMine"];
  takeRemote: SyncActions["takeRemote"];
  compare: SyncActions["compare"];
  onOpenChange: (open: boolean) => void;
}
interface ActionControlPublication {
  presentation: SyncPresentation;
  kind: SyncActionKind;
  invoke: () => Promise<string>;
}
interface CompareControlPublication {
  presentation: SyncPresentation;
  kind: "compare";
  invoke: SyncActions["compare"];
}
type ControlPublication = ActionControlPublication | CompareControlPublication;
type ControlOwner = { publication: ControlPublication; element: HTMLButtonElement };
type InputPublication = { presentation: SyncPresentation };
type InputOwner = { publication: InputPublication; element: HTMLInputElement };
type DialogEventPublication = { presentation: SyncPresentation };
type DialogEventOwner = { publication: DialogEventPublication; element: HTMLDivElement };
type OpenChangeClaim = { publication: DialogEventPublication; target: EventTarget | null };
type ActionOwner = { presentation: SyncPresentation; publication: ActionControlPublication };
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
  const [mount] = useState(() => Symbol("sync-dialog"));
  const activePresentationRef = useRef<SyncPresentation | null>(null);
  const inFlightRef = useRef<ActionOwner | null>(null);
  const successCloseRef = useRef<SuccessClose | null>(null);
  const controlOwnersRef = useRef(new Map<SyncControlKind, ControlOwner>());
  const inputOwnerRef = useRef<InputOwner | null>(null);
  const dialogEventOwnerRef = useRef<DialogEventOwner | null>(null);
  const openChangeClaimRef = useRef<OpenChangeClaim | null>(null);
  const docId = doc.id;
  const storage = doc.storage;
  const repoPath = doc.repoPath;
  const gistFile = doc.gistFile;
  const repoOwner = doc.repoOwner;
  const repoName = doc.repoName;
  const repoBranch = doc.repoBranch;
  const publishedAt = doc.publishedAt;
  const syncLines = sync?.lines ?? null;
  const syncRemote = sync?.remote ?? null;
  const status = sync?.status ?? "diverged";
  const localChanged = sync?.localChanged ?? false;
  const remoteChanged = sync?.remoteChanged ?? false;
  const localLines = syncLines?.local ?? 0;
  const remoteLines = syncLines?.remote ?? 0;
  const remoteUpdatedAt = syncRemote?.updatedAt ?? null;
  const remoteSha = syncRemote?.sha ?? null;
  const remoteSize = sync?.size ?? null;
  const remoteLimit = sync?.limit ?? null;
  const remoteUnreadable = status === "remote-unreadable";
  const merge = actions.merge;
  const keepMine = actions.keepMine;
  const takeRemote = actions.takeRemote;
  const compare = actions.compare;
  const presentation = useMemo<SyncPresentation>(
    () => ({
      mount,
      open,
      doc,
      docId,
      storage,
      repoPath,
      gistFile,
      repoOwner,
      repoName,
      repoBranch,
      publishedAt,
      sync,
      syncLines,
      syncRemote,
      status,
      localChanged,
      remoteChanged,
      localLines,
      remoteLines,
      remoteUpdatedAt,
      remoteSha,
      remoteSize,
      remoteLimit,
      remoteUnreadable,
      actions,
      merge,
      keepMine,
      takeRemote,
      compare,
      onOpenChange,
    }),
    [
      actions,
      compare,
      doc,
      docId,
      gistFile,
      keepMine,
      localChanged,
      localLines,
      merge,
      mount,
      onOpenChange,
      open,
      publishedAt,
      remoteChanged,
      remoteLimit,
      remoteLines,
      remoteSha,
      remoteSize,
      remoteUnreadable,
      remoteUpdatedAt,
      repoBranch,
      repoName,
      repoOwner,
      repoPath,
      status,
      storage,
      sync,
      syncLines,
      syncRemote,
      takeRemote,
    ],
  );
  const initialMessageVisit = useMemo(
    () => (open ? { mount, docId, repoPath, gistFile, message: `Update ${repoPath ?? gistFile ?? "document"}` } : null),
    [docId, gistFile, mount, open, repoPath],
  );

  const retirePresentation = useCallback((candidate: SyncPresentation) => {
    let retired = false;
    if (activePresentationRef.current === candidate) {
      activePresentationRef.current = null;
      retired = true;
    }
    if (inFlightRef.current?.presentation === candidate) inFlightRef.current = null;
    const scheduledClose = successCloseRef.current;
    if (scheduledClose?.owner.presentation === candidate) {
      clearTimeout(scheduledClose.timer);
      successCloseRef.current = null;
    }
    for (const kind of ["merge", "keep", "take", "compare"] as const) {
      if (controlOwnersRef.current.get(kind)?.publication.presentation === candidate) {
        controlOwnersRef.current.delete(kind);
      }
    }
    if (inputOwnerRef.current?.publication.presentation === candidate) inputOwnerRef.current = null;
    if (dialogEventOwnerRef.current?.publication.presentation === candidate) dialogEventOwnerRef.current = null;
    if (openChangeClaimRef.current?.publication.presentation === candidate) openChangeClaimRef.current = null;
    return retired;
  }, []);
  const ownsPresentation = useCallback(
    (candidate: SyncPresentation) => activePresentationRef.current === candidate && candidate.mount === mount && candidate.open,
    [mount],
  );
  const closePresentation = useCallback(
    (candidate: SyncPresentation) => {
      if (!ownsPresentation(candidate) || !retirePresentation(candidate)) return;
      candidate.onOpenChange(false);
    },
    [ownsPresentation, retirePresentation],
  );

  useLayoutEffect(() => {
    const previous = activePresentationRef.current;
    if (previous && previous !== presentation) retirePresentation(previous);
    if (!presentation.open) {
      return () => {
        retirePresentation(presentation);
      };
    }

    activePresentationRef.current = presentation;
    setError(null);
    setDone(null);
    setBusy(null);
    return () => {
      retirePresentation(presentation);
    };
  }, [presentation, retirePresentation]);

  useLayoutEffect(() => {
    if (initialMessageVisit) setMessage(initialMessageVisit.message);
  }, [initialMessageVisit]);

  const setControlElement = (publication: ControlPublication, element: HTMLButtonElement | null) => {
    if (element) {
      controlOwnersRef.current.set(publication.kind, { publication, element });
    } else if (controlOwnersRef.current.get(publication.kind)?.publication === publication) {
      controlOwnersRef.current.delete(publication.kind);
    }
  };
  const setInputElement = (publication: InputPublication, element: HTMLInputElement | null) => {
    if (element) {
      inputOwnerRef.current = { publication, element };
    } else if (inputOwnerRef.current?.publication === publication) {
      inputOwnerRef.current = null;
    }
  };
  const setDialogEventElement = (publication: DialogEventPublication, element: HTMLDivElement | null) => {
    if (element) {
      dialogEventOwnerRef.current = { publication, element };
    } else if (dialogEventOwnerRef.current?.publication === publication) {
      dialogEventOwnerRef.current = null;
    }
  };
  const ownsControl = (publication: ControlPublication, element: HTMLButtonElement) => {
    const owner = controlOwnersRef.current.get(publication.kind);
    return ownsPresentation(publication.presentation) && owner?.publication === publication && owner.element === element && element.isConnected;
  };
  const ownsInput = (publication: InputPublication, element: HTMLInputElement) => {
    const owner = inputOwnerRef.current;
    return ownsPresentation(publication.presentation) && owner?.publication === publication && owner.element === element && element.isConnected;
  };
  const ownsDialogEvent = (publication: DialogEventPublication, element: HTMLDivElement) => {
    const owner = dialogEventOwnerRef.current;
    return ownsPresentation(publication.presentation) && owner?.publication === publication && owner.element === element && element.isConnected;
  };

  // Radix handles Escape and outside pointer events in document capture, before portal React capture.
  useLayoutEffect(() => {
    const authorizeNativeOpenChange = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const owner = dialogEventOwnerRef.current;
      if (!owner || !ownsPresentation(owner.publication.presentation) || !owner.element.isConnected) return;
      const claim = { publication: owner.publication, target: event.target };
      openChangeClaimRef.current = claim;
      queueMicrotask(() => {
        if (openChangeClaimRef.current === claim) openChangeClaimRef.current = null;
      });
    };
    document.addEventListener("keydown", authorizeNativeOpenChange, true);
    document.addEventListener("pointerdown", authorizeNativeOpenChange, true);
    return () => {
      document.removeEventListener("keydown", authorizeNativeOpenChange, true);
      document.removeEventListener("pointerdown", authorizeNativeOpenChange, true);
    };
  }, [ownsPresentation]);

  const run = async (publication: ActionControlPublication, element: HTMLButtonElement) => {
    const candidate = publication.presentation;
    if (
      !ownsControl(publication, element) ||
      inFlightRef.current ||
      successCloseRef.current ||
      ((publication.kind === "merge" || publication.kind === "take") && candidate.remoteUnreadable)
    ) return;

    const owner = { presentation: candidate, publication };
    inFlightRef.current = owner;
    setBusy(publication.kind);
    setError(null);
    setDone(null);
    try {
      const note = await publication.invoke();
      if (!ownsPresentation(candidate) || inFlightRef.current !== owner) return;
      setDone(note);
      const timer = setTimeout(() => {
        if (successCloseRef.current?.owner !== owner || !ownsPresentation(candidate)) return;
        closePresentation(candidate);
      }, 900);
      successCloseRef.current = { owner, timer };
    } catch (e) {
      if (!ownsPresentation(candidate) || inFlightRef.current !== owner) return;
      setError(apiErrorText(e, "Sync failed"));
    } finally {
      if (ownsPresentation(candidate) && inFlightRef.current === owner) {
        inFlightRef.current = null;
        setBusy(null);
      }
    }
  };

  const dialogEventPublication: DialogEventPublication = { presentation };
  const inputPublication: InputPublication = { presentation };
  const publishedMessage = message.trim();
  const mergePublication: ActionControlPublication = {
    presentation,
    kind: "merge",
    invoke: async () => {
      const conflicts = await presentation.merge();
      return conflicts > 0 ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve in the editor` : "Merged — review, then publish";
    },
  };
  const keepPublication: ActionControlPublication = {
    presentation,
    kind: "keep",
    invoke: async () => (await presentation.keepMine(publishedMessage), "Published your version"),
  };
  const takePublication: ActionControlPublication = {
    presentation,
    kind: "take",
    invoke: async () => (await presentation.takeRemote(), "Replaced with GitHub's copy"),
  };
  const comparePublication: CompareControlPublication = {
    presentation,
    kind: "compare",
    invoke: presentation.compare,
  };
  const activateCompare = (publication: CompareControlPublication, element: HTMLButtonElement) => {
    const candidate = publication.presentation;
    if (
      !ownsControl(publication, element) ||
      candidate.remoteUnreadable ||
      inFlightRef.current ||
      successCloseRef.current ||
      !retirePresentation(candidate)
    ) return;
    publication.invoke();
    candidate.onOpenChange(false);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (ownsPresentation(presentation)) presentation.onOpenChange(true);
      return;
    }
    const claim = openChangeClaimRef.current;
    if (claim?.publication !== dialogEventPublication) return;
    openChangeClaimRef.current = null;
    closePresentation(presentation);
  };
  const authorizeOpenChange = (
    publication: DialogEventPublication,
    element: HTMLDivElement,
    target: EventTarget | null,
  ) => {
    if (!ownsDialogEvent(publication, element)) return;
    openChangeClaimRef.current = { publication, target };
  };
  const releaseOpenChange = (publication: DialogEventPublication, target: EventTarget | null) => {
    const claim = openChangeClaimRef.current;
    if (claim?.publication === publication && claim.target === target) openChangeClaimRef.current = null;
  };
  const where = presentation.storage === "gist"
    ? "the gist"
    : `${presentation.repoOwner}/${presentation.repoName} (${presentation.repoBranch})`;
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const formatMb = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? String(Math.ceil(mb)) : String(Math.ceil(mb * 100) / 100);
  };
  const sizeMessage =
    presentation.remoteSize != null && presentation.remoteLimit != null
      ? `The GitHub file is ${formatMb(presentation.remoteSize)} MB, but Markdoc can read files up to ${formatMb(presentation.remoteLimit)} MB.`
      : "The GitHub file is too large for Markdoc to read.";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div
        ref={(element) => setDialogEventElement(dialogEventPublication, element)}
        className="contents"
        onClickCapture={(event) => authorizeOpenChange(dialogEventPublication, event.currentTarget, event.target)}
        onClick={(event) => releaseOpenChange(dialogEventPublication, event.target)}
        onPointerDownCapture={(event) => authorizeOpenChange(dialogEventPublication, event.currentTarget, event.target)}
        onPointerDown={(event) => releaseOpenChange(dialogEventPublication, event.target)}
        onKeyDownCapture={(event) => authorizeOpenChange(dialogEventPublication, event.currentTarget, event.target)}
        onKeyDown={(event) => releaseOpenChange(dialogEventPublication, event.target)}
      >
        <DialogContent
          title="Sync with GitHub"
          description={presentation.remoteUnreadable ? `The file in ${where} cannot be read until it is made smaller or replaced.` : `This document and ${where} both changed since they were last in sync.`}
        >
          <div className="flex flex-col gap-4" data-testid="sync-dialog" data-status={presentation.status}>
          {presentation.remoteUnreadable ? (
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
                  {presentation.localChanged ? `${plural(presentation.localLines)} changed` : "No changes"}
                </div>
                <div className="text-xs text-ink-3">since {presentation.publishedAt ? relativeTime(presentation.publishedAt) : "the last sync"}</div>
              </div>
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-3">On GitHub</div>
                <div className="mt-1 font-medium text-ink" data-testid="sync-remote-lines">
                  {presentation.remoteChanged ? `${plural(presentation.remoteLines)} changed` : "No changes"}
                </div>
                <div className="truncate text-xs text-ink-3">
                  {presentation.remoteUpdatedAt ? `updated ${relativeTime(presentation.remoteUpdatedAt)}` : presentation.remoteSha ? `at ${presentation.remoteSha.slice(0, 7)}` : "\u00a0"}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {!presentation.remoteUnreadable && (
              <button
                ref={(element) => setControlElement(mergePublication, element)}
                type="button"
                className="btn btn-primary justify-start gap-2"
                disabled={!!busy || !!done}
                data-testid="sync-merge"
                onClick={(event) => void run(mergePublication, event.currentTarget)}
              >
                {busy === "merge" ? <Loader2 size={16} className="animate-spin" /> : <GitMerge size={16} />}
                <span className="flex flex-col items-start">
                  <span>Merge</span>
                  <span className="text-xs font-normal opacity-80">Combine both sets of edits; conflicting lines are marked for you to resolve.</span>
                </span>
              </button>
            )}
            <button
              ref={(element) => setControlElement(keepPublication, element)}
              type="button"
              className="btn btn-outline justify-start gap-2"
              disabled={!!busy || !!done}
              data-testid="sync-keep-mine"
              onClick={(event) => void run(keepPublication, event.currentTarget)}
            >
              {busy === "keep" ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
              <span className="flex flex-col items-start">
                <span>Keep mine</span>
                <span className="text-xs font-normal text-ink-3">Force-publish this document over the GitHub file.</span>
              </span>
            </button>
            {!presentation.remoteUnreadable && (
              <>
                <button
                  ref={(element) => setControlElement(takePublication, element)}
                  type="button"
                  className="btn btn-outline justify-start gap-2"
                  disabled={!!busy || !!done}
                  data-testid="sync-take-remote"
                  onClick={(event) => void run(takePublication, event.currentTarget)}
                >
                  {busy === "take" ? <Loader2 size={16} className="animate-spin" /> : <CloudDownload size={16} />}
                  <span className="flex flex-col items-start">
                    <span>Take GitHub</span>
                    <span className="text-xs font-normal text-ink-3">Force-pull; your local edits are kept in version history.</span>
                  </span>
                </button>
                <button
                  ref={(element) => setControlElement(comparePublication, element)}
                  type="button"
                  className="btn btn-ghost justify-start gap-2"
                  disabled={!!busy}
                  data-testid="sync-compare"
                  onClick={(event) => activateCompare(comparePublication, event.currentTarget)}
                >
                  <Scale size={16} /> Compare GitHub with this document
                </button>
              </>
            )}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-2">{presentation.storage === "gist" ? "Description" : "Commit message"} <span className="font-normal text-ink-3">(for Keep mine)</span></span>
            <input
              ref={(element) => setInputElement(inputPublication, element)}
              className="input"
              value={message}
              onChange={(event) => {
                if (!ownsInput(inputPublication, event.currentTarget)) return;
                setMessage(event.currentTarget.value);
              }}
              data-testid="commit-message"
            />
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
      </div>
    </Dialog>
  );
});
