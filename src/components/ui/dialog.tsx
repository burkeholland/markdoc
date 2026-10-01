"use client";

import * as React from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import { firstTabbable, focusReturnTarget, restoreFocus } from "@/lib/a11y";
import { cn } from "@/lib/utils";

/* ---------------- Dialog ---------------- */

const OVERLAY_CLASS_NAME = "dialog-overlay animate-fade-in";
const HEADER_CLASS_NAME = "mb-4 flex items-start justify-between gap-4";
const TITLE_GROUP_CLASS_NAME = "min-w-0";
const TITLE_CLASS_NAME = "text-lg font-semibold text-ink wrap-anywhere";
const DESCRIPTION_CLASS_NAME = "mt-1 text-sm text-ink-3 wrap-anywhere";
const HIDDEN_DESCRIPTION_CLASS_NAME = "sr-only";
const CLOSE_CLASS_NAME = "icon-btn -mr-2 -mt-1 h-8 w-8 shrink-0";

function currentFocusReturnTarget() {
  return typeof document === "undefined" ? null : focusReturnTarget();
}

/** The element that had focus when the enclosing `Dialog` opened; undefined outside a `Dialog`. */
const DialogOpenerContext = React.createContext<HTMLElement | null | undefined>(undefined);

/**
 * Radix's Root, plus the element that opened it. Dialogs here mostly open from state (no Radix Trigger),
 * so Radix would leave focus on <body> when they close. The opener has to be read while this render is
 * still pending: once React commits, a ⋮ menu item that opened the dialog has unmounted and focus is on
 * <body> (issue #161). `DialogContent` cannot read it itself because Radix mounts its content one layout
 * effect later, through the portal.
 */
export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<typeof RadixDialog.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const actualOpen = open ?? uncontrolledOpen;
  const [opening, setOpening] = React.useState(() => ({
    open: actualOpen,
    opener: actualOpen ? currentFocusReturnTarget() : null,
  }));
  if (opening.open !== actualOpen) {
    setOpening({ open: actualOpen, opener: actualOpen ? currentFocusReturnTarget() : opening.opener });
  }
  const handleOpenChange = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  return (
    <DialogOpenerContext.Provider value={opening.opener}>
      <RadixDialog.Root {...props} open={actualOpen} onOpenChange={handleOpenChange}>
        {children}
      </RadixDialog.Root>
    </DialogOpenerContext.Provider>
  );
}

export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogPortal = RadixDialog.Portal;
export const DialogOverlay = RadixDialog.Overlay;
export const DialogTitle = RadixDialog.Title;
/** Unstyled Radix content for drawers and sheets; `DialogContent` below is the centred card. */
export const DialogPrimitiveContent = RadixDialog.Content;

/**
 * Mounted with the dialog body. Records where focus should go back to on close: the opener the `Dialog`
 * root saw, or (for a `DialogContent` used without one) whatever has focus now.
 *
 * Then, for one task: a closing ⋮ menu hands focus back to its trigger in a `setTimeout(0)` queued when it
 * unmounted (Radix FocusScope). A dialog whose content mounts before that timer runs (one whose chunk was
 * still loading) already has focus on its first control, and the trigger would win, so typing went to the
 * ⋮ button (#1349). If focus is taken, note where it went (the opener the root could not see, since the
 * menu was already gone) and, if focus is still outside the open dialog, bring it back to the first control.
 */
function OpeningFocus({
  contentRef,
  returnRef,
}: {
  contentRef: React.RefObject<HTMLDivElement | null>;
  returnRef: React.RefObject<HTMLElement | null>;
}) {
  const rootOpener = React.useContext(DialogOpenerContext);
  const [opener] = React.useState(() => rootOpener ?? currentFocusReturnTarget());
  React.useLayoutEffect(() => {
    returnRef.current = opener;
  }, [opener, returnRef]);
  React.useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (to instanceof HTMLElement && !content.contains(to) && !to.closest('[role="dialog"]')) {
        returnRef.current ??= to;
      }
    };
    content.addEventListener("focusout", onFocusOut);
    const timer = setTimeout(() => {
      content.removeEventListener("focusout", onFocusOut);
      if (!content.isConnected || content.contains(document.activeElement)) return;
      (firstTabbable(content) ?? content).focus({ preventScroll: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      content.removeEventListener("focusout", onFocusOut);
    };
  }, [contentRef, returnRef]);
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
   * goes to the opener - the toolbar button, so the next keystroke went to the button (task #437).
   */
  onClosed?: () => void;
}) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const returnRef = React.useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={OVERLAY_CLASS_NAME} />
      <RadixDialog.Content
        ref={contentRef}
        className={cn("dialog animate-fade-in", wide && "w-[min(94vw,760px)]", className)}
        onOpenAutoFocus={(e) => {
          // Radix would focus the first tabbable control, the Close button in the header. Start on the
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
          const target = e.target instanceof Element ? e.target : document.activeElement;
          const combobox = target?.closest('[role="combobox"][aria-expanded="true"]');
          if (combobox && contentRef.current?.contains(combobox)) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const returnTarget = returnRef.current;
          returnRef.current = null;
          restoreFocus(returnTarget);
          onClosed?.();
        }}
      >
        <OpeningFocus contentRef={contentRef} returnRef={returnRef} />
        <div className={HEADER_CLASS_NAME} data-focus-skip>
          <div className={TITLE_GROUP_CLASS_NAME}>
            <RadixDialog.Title className={TITLE_CLASS_NAME}>{title}</RadixDialog.Title>
            {description !== undefined ? (
              <RadixDialog.Description className={DESCRIPTION_CLASS_NAME}>{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description className={HIDDEN_DESCRIPTION_CLASS_NAME}>{title}</RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close type="button" className={CLOSE_CLASS_NAME} aria-label="Close">
            <X size={16} />
          </RadixDialog.Close>
        </div>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
