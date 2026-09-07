"use client";

import * as React from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import { firstTabbable, focusReturnTarget, restoreFocus } from "@/lib/a11y";
import { cn } from "@/lib/utils";

/* ---------------- Dialog ---------------- */

interface OpeningFocusOwner {
  content: HTMLDivElement;
  opener: HTMLElement | null;
  returnTarget: HTMLElement | null;
  returnTargetClaimed: boolean;
  onClosed: (() => void) | undefined;
  onFocusOut: (event: FocusEvent) => void;
  timer: ReturnType<typeof setTimeout> | null;
  listenerAttached: boolean;
  mounted: boolean;
  opening: boolean;
  closed: boolean;
  previousContent: HTMLDivElement | null;
}

interface DialogFocusAuthority {
  current: () => OpeningFocusOwner | null;
  claim: (owner: OpeningFocusOwner) => void;
  release: (owner: OpeningFocusOwner) => void;
}

function createDialogFocusAuthority(): DialogFocusAuthority {
  let current: OpeningFocusOwner | null = null;
  return {
    current: () => current,
    claim: (owner) => {
      current = owner;
    },
    release: (owner) => {
      if (current === owner) current = null;
    },
  };
}

const DialogFocusAuthorityContext = React.createContext<DialogFocusAuthority | null>(null);

export function Dialog(props: React.ComponentProps<typeof RadixDialog.Root>) {
  const [authority] = React.useState(createDialogFocusAuthority);
  return (
    <DialogFocusAuthorityContext.Provider value={authority}>
      <RadixDialog.Root {...props} />
    </DialogFocusAuthorityContext.Provider>
  );
}

export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogPortal = RadixDialog.Portal;
export const DialogOverlay = RadixDialog.Overlay;
export const DialogTitle = RadixDialog.Title;
/** Unstyled Radix content for drawers and sheets; `DialogContent` below is the centred card. */
export const DialogPrimitiveContent = RadixDialog.Content;

function removeOpeningListener(owner: OpeningFocusOwner) {
  if (!owner.listenerAttached) return;
  owner.listenerAttached = false;
  owner.content.removeEventListener("focusout", owner.onFocusOut);
}

function retireOpening(owner: OpeningFocusOwner) {
  if (!owner.opening) return;
  owner.opening = false;
  const timer = owner.timer;
  owner.timer = null;
  if (timer !== null) clearTimeout(timer);
  removeOpeningListener(owner);
}

/**
 * The content subtree first renders before its exact DOM node commits, while the control that opened it
 * still owns focus. This also runs when Radix replaces that DOM behind a stable `DialogContent`.
 */
function CaptureOpeningFocus({
  onCapture,
}: {
  onCapture: (opener: HTMLElement | null) => void;
}) {
  const [opener] = React.useState(focusReturnTarget);
  React.useLayoutEffect(() => {
    onCapture(opener);
  }, [onCapture, opener]);
  return null;
}

export function DialogContent({
  title,
  description,
  children,
  className,
  wide,
  onClosed,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
  /**
   * Runs once the closed dialog has let go of focus. An action that must leave focus in the editor
   * (insert a table, apply a link) belongs here rather than in the button's onClick: while the modal
   * is still mounted its focus trap pulls focus straight back into the dialog, and on unmount focus
   * goes to the opener — the toolbar button, so the next keystroke went to the button (task #437).
   */
  onClosed?: () => void;
}) {
  const inheritedAuthority = React.useContext(DialogFocusAuthorityContext);
  const [localAuthority] = React.useState(createDialogFocusAuthority);
  const authority = inheritedAuthority ?? localAuthority;
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const ownedRef = React.useRef<OpeningFocusOwner | null>(null);
  const [visitOnClosed] = React.useState(() => onClosed);

  const establishOwner = React.useCallback(
    (content: HTMLDivElement) => {
      const owned = ownedRef.current;
      if (owned?.content === content && owned.mounted && authority.current() === owned) return owned;

      if (owned) {
        owned.mounted = false;
        retireOpening(owned);
      }
      const previous = authority.current();
      if (previous && previous !== owned) retireOpening(previous);
      const candidate = focusReturnTarget();
      const candidateIsDialogFocus = content.contains(candidate) || previous?.content.contains(candidate);
      const opener = previous && !previous.closed && (!candidate || candidateIsDialogFocus) ? previous.opener : candidateIsDialogFocus ? null : candidate;

      const onFocusOut = (event: FocusEvent) => {
        if (authority.current() !== owner || !owner.mounted || !owner.opening || owner.onFocusOut !== onFocusOut || owner.timer === null) return;
        const to = event.relatedTarget;
        if (to instanceof HTMLElement && !owner.content.contains(to) && owner.returnTarget === null) {
          owner.returnTarget = to;
          owner.returnTargetClaimed = true;
        }
      };
      const owner: OpeningFocusOwner = {
        content,
        opener,
        returnTarget: opener,
        returnTargetClaimed: false,
        onClosed: visitOnClosed,
        onFocusOut,
        timer: null,
        listenerAttached: true,
        mounted: true,
        opening: true,
        closed: false,
        previousContent: previous?.content ?? null,
      };
      authority.claim(owner);
      ownedRef.current = owner;
      content.addEventListener("focusout", onFocusOut);
      const recoverOpeningFocus = () => {
        if (authority.current() !== owner || !owner.mounted || !owner.opening || owner.timer !== timer) return;
        owner.timer = null;
        owner.opening = false;
        removeOpeningListener(owner);
        if (!owner.content.isConnected || owner.content.contains(document.activeElement)) return;
        (firstTabbable(owner.content) ?? owner.content).focus({ preventScroll: true });
      };
      const timer = setTimeout(recoverOpeningFocus, 0);
      owner.timer = timer;
      return owner;
    },
    [authority, visitOnClosed],
  );

  const setContentRef = React.useCallback(
    (content: HTMLDivElement | null) => {
      contentRef.current = content;
      if (!content) {
        const owner = ownedRef.current;
        if (owner) {
          owner.mounted = false;
          retireOpening(owner);
        }
        return;
      }

      establishOwner(content);
      return () => {
        if (contentRef.current === content) contentRef.current = null;
        const owner = ownedRef.current;
        if (owner?.content === content) {
          owner.mounted = false;
          retireOpening(owner);
        }
      };
    },
    [establishOwner],
  );

  const publishOpeningDetails = React.useCallback(
    (opener: HTMLElement | null) => {
      const owner = ownedRef.current;
      if (!owner || authority.current() !== owner || owner.content !== contentRef.current) return;
      if (!owner.content.contains(opener) && !owner.previousContent?.contains(opener)) {
        owner.opener = opener;
        if (!owner.returnTargetClaimed) owner.returnTarget = opener;
      }
      owner.previousContent = null;
    },
    [authority],
  );

  // A composed Radix ref can keep the same ref objects while replacing their exact DOM element.
  // Resolve it after every commit as well as in the callback ref's earlier mutation-phase cleanup.
  React.useLayoutEffect(() => {
    const content = contentRef.current;
    if (content) establishOwner(content).onClosed = onClosed;
  });

  React.useLayoutEffect(
    () => () => {
      const owner = ownedRef.current;
      if (owner) {
        owner.mounted = false;
        retireOpening(owner);
      }
    },
    [],
  );

  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="dialog-overlay animate-fade-in" />
      <RadixDialog.Content
        ref={setContentRef}
        className={cn("dialog animate-fade-in", wide && "w-[min(94vw,760px)]", className)}
        onOpenAutoFocus={(e) => {
          const content = e.currentTarget;
          const owner = authority.current();
          if (!(content instanceof HTMLDivElement) || owner?.content !== content || owner.closed) return;
          // Radix only gets here when focus is outside the dialog — e.g. the ⋮ menu that opened it gave
          // focus back to its trigger after the input's `autoFocus` had already run (task #474) — and
          // would then focus the first tabbable control, the Close button in the header. Start on the
          // first control of the body instead so typing goes into the form and Enter submits it.
          const first = firstTabbable(content);
          if (first) {
            e.preventDefault();
            first.focus({ preventScroll: true });
          }
        }}
        onEscapeKeyDown={(e) => {
          // An expanded combobox (the Share dialog's handle suggestions) takes the first Escape to close
          // its list; the dialog closes on the next one. Radix listens on the document in the capture
          // phase, so the combobox cannot stop the event itself.
          if ((e.target as Element | null)?.closest?.('[role="combobox"][aria-expanded="true"]')) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const content = e.currentTarget;
          const owner = authority.current();
          if (!(content instanceof HTMLDivElement) || owner?.content !== content || owner.closed) return;
          owner.closed = true;
          authority.release(owner);
          if (ownedRef.current === owner) ownedRef.current = null;
          retireOpening(owner);
          const returnTarget = owner.returnTarget;
          owner.returnTarget = null;
          restoreFocus(returnTarget);
          owner.onClosed?.();
        }}
      >
        <CaptureOpeningFocus onCapture={publishOpeningDetails} />
        <div className="mb-4 flex items-start justify-between gap-4" data-focus-skip>
          <div>
            <RadixDialog.Title className="text-lg font-semibold text-ink">{title}</RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-1 text-sm text-ink-3">{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close className="icon-btn -mr-2 -mt-1 h-8 w-8 shrink-0" aria-label="Close">
            <X size={16} />
          </RadixDialog.Close>
        </div>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
