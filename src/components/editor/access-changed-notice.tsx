"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import type { AccessChange } from "@/editor/collab/session";
import { Dialog, DialogOverlay, DialogPortal, DialogPrimitiveContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * What a person sees when the owner changes their access while the document is open (issue #2269).
 *
 * The page keeps the role it was built with. Lowered or removed: a dialog that only its button leaves, over
 * panes the session has already made read-only. Raised: a quiet bar that takes no focus. Either way the way
 * on is a load of the page, which the server renders for the role the person has now.
 */

const ROLE_NAME = { viewer: "Viewer", commenter: "Commenter", editor: "Editor", owner: "Owner" } as const;

export const ACCESS_CHANGED_TITLE = "Your access changed";
export const ACCESS_UNSAVED_TEXT = "Changes you made in the last moments were not saved.";

/** The sentence under the title, for the role the server holds now. */
export function accessChangedText(change: AccessChange): string {
  if (change.kind === "removed" || change.role === null) return "You no longer have access to this document.";
  if (change.kind === "raised") return change.role === "commenter" ? "You can now comment on this document." : "You can now edit this document.";
  return `The owner changed your access to this document to ${ROLE_NAME[change.role]}. Reload to continue.`;
}

/**
 * How long the page must have been without a key or a pointer press before the button acts. The notice
 * arrives while the person is doing something else: typing, holding a key, in the middle of a double-click.
 * Longer than the 500 ms within which Windows counts two clicks as a double-click.
 */
export const QUIET_MS = 600;

const QUIET_EVENTS = ["keydown", "keyup", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"] as const;

/**
 * A button that appeared without being asked for acts only on a press that is meant for it.
 *
 * It stays unarmed until {@link QUIET_MS} have passed with no key and no pointer press anywhere on the page;
 * every such event before that starts the wait again, so the keys of a fast typist, the repeats of a held
 * Enter or Space and the second click of a double-click never reach the action. Once armed it stays armed.
 * Then Enter and Space act when the key is released, and only when that same press began on the button;
 * a pointer click acts only when the pointer went down on the button too.
 */
export function useMeantPress(action: () => void) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const key = useRef<string | null>(null);
  const pointer = useRef(false);

  useEffect(() => {
    if (armedRef.current) return;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      clearTimeout(timer);
      for (const type of QUIET_EVENTS) window.removeEventListener(type, wait, true);
    };
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stop();
        armedRef.current = true;
        setArmed(true);
      }, QUIET_MS);
    };
    for (const type of QUIET_EVENTS) window.addEventListener(type, wait, true);
    wait();
    return stop;
  }, []);

  return {
    armed,
    handlers: {
      onPointerDown: () => {
        pointer.current = armedRef.current;
      },
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        // No pointer and `detail` 0: a screen reader or voice control. Enter and Space never click here (below).
        const meant = event.detail === 0 || pointer.current;
        pointer.current = false;
        if (armedRef.current && meant) action();
      },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Always cancelled: a native button would click on every repeat of a held Enter, and on the release of a held Space.
        event.preventDefault();
        if (event.repeat || !armedRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
        key.current = event.key;
      },
      onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const pressed = key.current;
        key.current = null;
        if (pressed === event.key && armedRef.current) action();
      },
      onBlur: () => {
        key.current = null;
        pointer.current = false;
      },
    },
  };
}

/** Longest the button waits for the local copy to be gone before it leaves the page anyway. */
const DISCARD_WAIT_MS = 2_000;

function MeantButton({ label, onAct, className, focusRef }: { label: string; onAct: () => void; className: string; focusRef?: RefObject<HTMLButtonElement | null> }) {
  const { armed, handlers } = useMeantPress(onAct);
  return (
    <button ref={focusRef} type="button" className={cn(className, "transition-opacity", !armed && "opacity-60")} aria-disabled={!armed} data-armed={armed} data-testid="access-changed-action" {...handlers}>
      {label}
    </button>
  );
}

/** A comment or reply the person was writing: it cannot be sent from this page any more. */
function hasCommentDraft(): boolean {
  return Array.from(document.querySelectorAll<HTMLTextAreaElement>('[data-testid="comments-panel"] textarea, textarea[data-testid="comment-composer"]')).some(
    (box) => box.value.trim() !== "",
  );
}

function BlockedDialog({ change, discardLocal, onDocuments }: { change: AccessChange; discardLocal: () => Promise<void>; onDocuments: () => void }) {
  const describedBy = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  // Read once, as the dialog arrives: the composer under it can no longer be reached.
  const [draft] = useState(hasCommentDraft);
  const discarded = useRef<Promise<void> | null>(null);
  // Only now that the person is being told: what this device kept of the document is deleted, so that a
  // load of the page shows the server's document and not text the server never accepted.
  useEffect(() => {
    discarded.current ??= discardLocal().catch(() => undefined);
  }, [discardLocal]);
  const removed = change.kind === "removed";
  const leave = useCallback(() => {
    const go = () => (removed ? onDocuments() : window.location.reload());
    const gone = discarded.current ?? Promise.resolve();
    void Promise.race([gone, new Promise((resolve) => setTimeout(resolve, DISCARD_WAIT_MS))]).then(go, go);
  }, [removed, onDocuments]);
  const keep = (event: Event) => event.preventDefault();
  return (
    <Dialog open>
      <DialogPortal>
        <DialogOverlay className="dialog-overlay animate-fade-in" />
        <DialogPrimitiveContent
          role="alertdialog"
          className="dialog animate-fade-in"
          aria-describedby={describedBy}
          data-testid="access-changed-dialog"
          data-kind={change.kind}
          // Nothing but the button leaves it.
          onEscapeKeyDown={keep}
          onPointerDownOutside={keep}
          onInteractOutside={keep}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            button.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle className="text-lg font-semibold text-ink wrap-anywhere">{ACCESS_CHANGED_TITLE}</DialogTitle>
          <div id={describedBy} className="mt-2 space-y-2 text-sm text-ink-2">
            <p data-testid="access-changed-text">{accessChangedText(change)}</p>
            {(change.unsaved || draft) && <p data-testid="access-changed-unsaved">{ACCESS_UNSAVED_TEXT}</p>}
          </div>
          <div className="mt-6 flex justify-end">
            <MeantButton focusRef={button} label={removed ? "Go to your documents" : "Reload"} onAct={leave} className="btn btn-primary" />
          </div>
        </DialogPrimitiveContent>
      </DialogPortal>
    </Dialog>
  );
}

function RaisedNotice({ change }: { change: AccessChange }) {
  const reload = useCallback(() => window.location.reload(), []);
  return (
    <div className="flex items-center justify-center gap-3 bg-accent-soft px-4 py-2 text-sm text-ink" role="status" data-testid="access-raised-notice">
      <span data-testid="access-changed-text">{accessChangedText(change)}</span>
      <MeantButton label="Reload" onAct={reload} className="btn btn-sm btn-outline" />
    </div>
  );
}

export function AccessChangedNotice({
  change,
  discardLocal,
  onDocuments,
}: {
  change: AccessChange | null;
  /** Deletes what this device kept of the document; called once the blocking dialog is on screen. */
  discardLocal: () => Promise<void>;
  /** Leaves for the dashboard (a person who was removed has nothing to reload). */
  onDocuments: () => void;
}) {
  if (!change) return null;
  if (change.kind === "raised") return <RaisedNotice change={change} />;
  return <BlockedDialog change={change} discardLocal={discardLocal} onDocuments={onDocuments} />;
}
