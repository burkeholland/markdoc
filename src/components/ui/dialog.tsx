"use client";

import * as React from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import { firstTabbable, focusReturnTarget, restoreFocus } from "@/lib/a11y";
import { cn } from "@/lib/utils";

/* ---------------- Dialog ---------------- */

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogPortal = RadixDialog.Portal;
export const DialogOverlay = RadixDialog.Overlay;
export const DialogTitle = RadixDialog.Title;
/** Unstyled Radix content for drawers and sheets; `DialogContent` below is the centred card. */
export const DialogPrimitiveContent = RadixDialog.Content;

/**
 * Mounted with the dialog body, so its first render is the one that mounts the dialog. React has not
 * committed yet at that point: the element that opened the dialog still exists and still has focus — the
 * ⋮ menu item about to unmount (resolved to its trigger), the toolbar button, the editor pane. Capturing it
 * in `onOpenAutoFocus` does not work: Radix skips that event when a child's `autoFocus` already put focus
 * inside the content (Image, Link, Name this version), and by the time any effect runs a menu
 * that opened the dialog is gone and `document.activeElement` is <body> (issue #161).
 */
function RememberOpener({ targetRef }: { targetRef: React.RefObject<HTMLElement | null> }) {
  const [opener] = React.useState(focusReturnTarget);
  React.useLayoutEffect(() => {
    targetRef.current = opener;
  }, [opener, targetRef]);
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
  // Dialogs here open from state (no Radix Trigger), so Radix would leave focus on <body> when they
  // close. Remember the opener — editor pane, toolbar or header button, the ⋮ menu's trigger — and hand
  // focus back to it (see RememberOpener).
  const returnRef = React.useRef<HTMLElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="dialog-overlay animate-fade-in" />
      <RadixDialog.Content
        ref={contentRef}
        className={cn("dialog animate-fade-in", wide && "w-[min(94vw,760px)]", className)}
        onOpenAutoFocus={(e) => {
          // Radix only gets here when focus is outside the dialog — e.g. the ⋮ menu that opened it gave
          // focus back to its trigger after the input's `autoFocus` had already run (task #474) — and
          // would then focus the first tabbable control, the Close button in the header. Start on the
          // first control of the body instead so typing goes into the form and Enter submits it.
          const first = firstTabbable(contentRef.current);
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
          restoreFocus(returnRef.current);
          returnRef.current = null;
          onClosed?.();
        }}
      >
        <RememberOpener targetRef={returnRef} />
        <div className="mb-4 flex items-start justify-between gap-4" data-focus-skip>
          <div>
            <RadixDialog.Title className="text-lg font-semibold text-ink">{title}</RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-1 text-sm text-ink-3">{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close className="icon-btn -mr-2 -mt-1 h-8 w-8" aria-label="Close">
            <X size={16} />
          </RadixDialog.Close>
        </div>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
