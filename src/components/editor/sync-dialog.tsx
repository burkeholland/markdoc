"use client";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AlertTriangle, Check, CloudDownload, GitMerge, Loader2, Scale, UploadCloud } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { apiErrorText, type SyncStatusDto } from "@/lib/api";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { useEnterOnRelease, usePlaceHold } from "./press-once";

type SyncActionKind = "merge" | "keep" | "take";

export interface SyncActions {
  /** pull?merge=1 — resolves to the number of conflicts left in the document (0 = clean merge). */
  merge: () => Promise<number>;
  keepMine: (message: string) => Promise<void>;
  takeRemote: () => Promise<void>;
  compare: () => void;
}

/**
 * The choices are `aria-disabled`, not `disabled`, while one of them runs and after it has succeeded: a
 * disabled button drops focus to the page when it switches off under the pointer or the key that pressed
 * it, and Escape and Tab then no longer reach the dialog. Pressing one that is off does nothing.
 */
const OFF = "aria-disabled:cursor-default aria-disabled:opacity-50";
const OFF_PRIMARY = `${OFF} aria-disabled:hover:bg-accent`;
const OFF_OUTLINE = `${OFF} aria-disabled:hover:bg-surface`;
const OFF_GHOST = `${OFF} aria-disabled:hover:bg-transparent`;

/** How long a result stays on screen before the dialog closes itself. */
const CLOSE_AFTER_MS = 900;
/**
 * The card keeps its top edge where a card of the usual height would have it when centred, and grows
 * downwards only. The error and result lines are the last thing in it, so the choices and the message
 * field stay where they are when one appears, changes or goes: a second click lands on the choice the
 * first one was aimed at, never on its neighbour. A card taller than the window scrolls inside.
 */
const PINNED = "[--pin:max(0.75rem,calc(50dvh-15rem))] top-(--pin) translate-y-0 max-h-[calc(100dvh-var(--pin)-0.75rem)] overflow-y-auto";
/** How far the pointer has to travel before it counts as moved: more than a shaking hand moves it. */
const TRAVEL_PX = 24;

const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
const formatMb = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? String(Math.ceil(mb)) : String(Math.ceil(mb * 100) / 100);
};

/**
 * Three-way summary for a document whose GitHub file and local text both moved. An oversized remote
 * file cannot be read, so only the force-publish path remains available.
 *
 * The header polls the sync status while the dialog is open, so this re-renders with a new `sync` every
 * few seconds. Nothing here depends on that object's identity: the typed message, a running action, its
 * result and the focus all stay as they are.
 */
export const SyncDialog = memo(function SyncDialog({
  open,
  onOpenChange,
  doc,
  sync,
  actions,
  unprompted = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  sync: SyncStatusDto | null;
  actions: SyncActions;
  /** The editor opened the dialog on its own: GitHub refused a commit or a pull. Read when a visit starts. */
  unprompted?: boolean;
}) {
  const defaultMessage = `Update ${doc.repoPath ?? doc.gistFile ?? "document"}`;
  // One visit is the dialog open on one file. Opening it, or the file changing under it, starts over.
  const visit = open ? `${doc.id}\n${doc.repoPath ?? ""}\n${doc.gistFile ?? ""}` : null;
  const [shownVisit, setShownVisit] = useState(visit);
  const [message, setMessage] = useState(defaultMessage);
  const [busy, setBusy] = useState<SyncActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // An unprompted visit appears under a pointer and a key that were aimed at something else: the Commit
  // button lies where Take GitHub is now, and a second click or Enter meant for it would run a choice. So
  // it starts "waiting": focus is on the dialog's body, not on a choice, and the choices are off. They
  // switch on ("ready") when the user does something new that is aimed at this dialog (see below).
  const [entry, setEntry] = useState<"asked" | "waiting" | "ready">(unprompted ? "waiting" : "asked");
  if (shownVisit !== visit) {
    setShownVisit(visit);
    if (visit !== null) {
      setMessage(defaultMessage);
      setBusy(null);
      setError(null);
      setDone(null);
      setEntry(unprompted ? "waiting" : "asked");
    }
  }
  // The action this visit is waiting for, from its click until its result has closed the dialog (or its
  // failure is shown). While it is set no other action starts. Ending the visit lets go of it: the
  // request itself goes on and the editor reports how it ended, but it no longer changes this dialog.
  const running = useRef<symbol | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  useEffect(
    () => () => {
      running.current = null;
    },
    [visit],
  );
  const messageRef = useRef<HTMLInputElement | null>(null);
  const enterOnRelease = useEnterOnRelease();
  // Compare closes the dialog under the pointer: the rest of a double-click must not land on the page.
  const compareHold = usePlaceHold(!open);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const live = entry !== "waiting";
  // What switches the choices of an unprompted visit on. No clock: only something the user does.
  useEffect(() => {
    if (live || visit === null) return;
    const ready = () => setEntry("ready");
    // The pointer has travelled, measured from where it is first seen: a shaking hand stays under that, and
    // so does the move a browser sends by itself when the page changes under a pointer that rests.
    let seen: { x: number; y: number } | null = null;
    const onPointerMove = (event: PointerEvent) => {
      seen ??= { x: event.clientX, y: event.clientY };
      if (Math.hypot(event.clientX - seen.x, event.clientY - seen.y) > TRAVEL_PX) ready();
    };
    // One whole press, or a tap, anywhere on the card. Heard on the document, so after the choices' own
    // handlers: the press that switches them on starts nothing itself.
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && bodyRef.current?.closest('[role="dialog"]')?.contains(event.target)) ready();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" || event.key.startsWith("Arrow")) ready();
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [live, visit]);

  const status = sync?.status ?? "diverged";
  const remoteUnreadable = status === "remote-unreadable";
  const off = busy !== null || done !== null || !live;

  // A double-click, or a double tap, is one press: its second click (`detail` 2) starts nothing, also
  // when the first one has already failed and the choices are on again.
  const run = (kind: SyncActionKind, event: ReactMouseEvent, action: () => Promise<string>) => {
    if (running.current || event.detail > 1 || !live) return;
    const own = Symbol(kind);
    running.current = own;
    // An error from the try before stays until this one has ended, so nothing moves at the click.
    setBusy(kind);
    let pending: Promise<string>;
    try {
      pending = action();
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (note) => {
        if (running.current !== own) return;
        setBusy(null);
        setError(null);
        setDone(note);
        // The result stays for a moment, then the dialog closes, unless the visit has ended by then.
        setTimeout(() => {
          if (running.current !== own) return;
          running.current = null;
          onOpenChangeRef.current(false);
        }, CLOSE_AFTER_MS);
      },
      (e: unknown) => {
        if (running.current !== own) return;
        running.current = null;
        setBusy(null);
        setError(apiErrorText(e, "Sync failed"));
      },
    );
  };
  const compare = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (running.current || event.detail > 1 || !live) return;
    compareHold.arm(event, event.currentTarget);
    actions.compare();
    onOpenChange(false);
  };

  // Arrow keys, Home and End move between the choices, as in a toolbar. They stop at the ends.
  const onChoicesKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const from = choices.findIndex((choice) => choice === event.target);
    if (from < 0 || off) return;
    const to =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? from + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? from - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? choices.length - 1
              : -1;
    const next = choices[to];
    if (!next || to === from) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };

  const where = doc.storage === "gist" ? "the gist" : `${doc.repoOwner}/${doc.repoName} (${doc.repoBranch})`;
  const lines = sync?.lines ?? { local: 0, remote: 0 };
  const remoteUpdatedAt = sync?.remote.updatedAt ?? null;
  const remoteSha = sync?.remote.sha ?? null;
  const sizeMessage =
    sync?.size != null && sync.limit != null
      ? `The GitHub file is ${formatMb(sync.size)} MB, but Markdoc can read files up to ${formatMb(sync.limit)} MB.`
      : "The GitHub file is too large for Markdoc to read.";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={PINNED}
          title="Sync with GitHub"
          description={remoteUnreadable ? `The file in ${where} cannot be read until it is made smaller or replaced.` : `This document and ${where} both changed since they were last in sync.`}
        >
          <div
            ref={bodyRef}
            className="flex flex-col gap-4"
            data-testid="sync-dialog"
            data-status={status}
            // The opening focus of an unprompted visit: the dialog takes its first tab stop, and Enter and
            // Space do nothing here. Tab goes on to the first choice, and so does an arrow key.
            tabIndex={entry === "asked" ? undefined : live ? -1 : 0}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && event.key.startsWith("Arrow") && !(event.altKey || event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
              }
              enterOnRelease.onKeyDown(event);
            }}
            onKeyUp={enterOnRelease.onKeyUp}
            onBlur={enterOnRelease.onBlur}
          >
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
                  <div className="text-xs text-ink-3" title={doc.publishedAt ? formatDateTime(doc.publishedAt) : undefined}>
                    since {doc.publishedAt ? relativeTime(doc.publishedAt) : "the last sync"}
                  </div>
                </div>
                <div className="rounded-xl border border-line bg-surface-2 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-3">On GitHub</div>
                  <div className="mt-1 font-medium text-ink" data-testid="sync-remote-lines">
                    {sync?.remoteChanged ? `${plural(lines.remote)} changed` : "No changes"}
                  </div>
                  <div className="truncate text-xs text-ink-3" title={remoteUpdatedAt ? formatDateTime(remoteUpdatedAt) : remoteSha || undefined}>
                    {remoteUpdatedAt ? `updated ${relativeTime(remoteUpdatedAt)}` : remoteSha ? `at ${remoteSha.slice(0, 7)}` : "\u00a0"}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2" onKeyDown={onChoicesKeyDown}>
              {!remoteUnreadable && (
                <button
                  type="button"
                  className={cn("btn btn-primary justify-start gap-2", OFF_PRIMARY)}
                  aria-disabled={off || undefined}
                  data-testid="sync-merge"
                  onClick={(event) =>
                    run("merge", event, async () => {
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
              <button
                type="button"
                className={cn("btn btn-outline justify-start gap-2", OFF_OUTLINE)}
                aria-disabled={off || undefined}
                data-testid="sync-keep-mine"
                onClick={(event) => {
                  // The message as the field shows it now, not as the last render saw it.
                  const text = (messageRef.current?.value ?? message).trim();
                  run("keep", event, async () => (await actions.keepMine(text), "Published your version"));
                }}
              >
                {busy === "keep" ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
                <span className="flex flex-col items-start">
                  <span>Keep mine</span>
                  <span className="text-xs font-normal text-ink-3">Force-publish this document over the GitHub file.</span>
                </span>
              </button>
              {!remoteUnreadable && (
                <>
                  <button
                    type="button"
                    className={cn("btn btn-outline justify-start gap-2", OFF_OUTLINE)}
                    aria-disabled={off || undefined}
                    data-testid="sync-take-remote"
                    onClick={(event) => run("take", event, async () => (await actions.takeRemote(), "Replaced with GitHub's copy"))}
                  >
                    {busy === "take" ? <Loader2 size={16} className="animate-spin" /> : <CloudDownload size={16} />}
                    <span className="flex flex-col items-start">
                      <span>Take GitHub</span>
                      <span className="text-xs font-normal text-ink-3">Force-pull; your local edits are kept in version history.</span>
                    </span>
                  </button>
                  <button type="button" className={cn("btn btn-ghost justify-start gap-2", OFF_GHOST)} aria-disabled={off || undefined} data-testid="sync-compare" onClick={compare}>
                    <Scale size={16} /> Compare GitHub with this document
                  </button>
                </>
              )}
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-2">
                {doc.storage === "gist" ? "Description" : "Commit message"} <span className="font-normal text-ink-3">(for Keep mine)</span>
              </span>
              <input ref={messageRef} className="input" value={message} onChange={(event) => setMessage(event.target.value)} data-testid="commit-message" />
            </label>

            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger wrap-anywhere dark:bg-red-950/40" role="alert">
                <AlertTriangle size={14} className="shrink-0" /> {error}
              </div>
            )}
            {done && (
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2 wrap-anywhere" data-testid="sync-done">
                <Check size={14} className="shrink-0 text-success" /> {done}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {compareHold.shield}
    </>
  );
});
