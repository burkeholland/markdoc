"use client";

import * as React from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import { firstTabbable, focusedElement, focusReturnTarget, restoreFocus } from "@/lib/a11y";
import { cn } from "@/lib/utils";

/* ---------------- Dialog ---------------- */

const OVERLAY_CLASS_NAME = "dialog-overlay animate-fade-in";
const HEADER_CLASS_NAME = "dialog-header mb-4 flex items-start justify-between gap-4";
const TITLE_GROUP_CLASS_NAME = "min-w-0";
const TITLE_CLASS_NAME = "text-lg font-semibold text-ink wrap-anywhere";
const DESCRIPTION_CLASS_NAME = "mt-1 text-sm text-ink-3 wrap-anywhere";
const HIDDEN_DESCRIPTION_CLASS_NAME = "sr-only";
const CLOSE_CLASS_NAME = "icon-btn tap-target relative -mr-2 -mt-1 h-8 w-8 shrink-0";

/** What had focus when a dialog opened. */
interface Opener {
  /** The focused element; a menu item resolves to its menu's trigger. */
  element: HTMLElement | null;
  /** When that element sits in a popover: the popover's trigger. */
  popoverTrigger: HTMLElement | null;
  /**
   * The dialog opened from a menu or popover (or from something already gone): that layer closes as the
   * dialog opens and hands focus back to its own trigger, which is then the better place to return to.
   */
  fromLayer: boolean;
}

const NO_OPENER: Opener = { element: null, popoverTrigger: null, fromLayer: true };

/**
 * A popover that opens a dialog closes as the dialog opens, so the popover's own button is gone when the
 * dialog closes, and Radix does not always hand focus back to the popover's trigger (it does not when
 * focus moved to the dialog while the popover was still on the page). Radix wires that trigger to the
 * popover with `aria-controls` while it is open, so it can be found now. Like `focusReturnTarget`, this
 * must run before the commit that closes the popover.
 */
function currentOpener(): Opener {
  if (typeof document === "undefined") return NO_OPENER;
  const element = focusReturnTarget();
  const popover = element?.closest<HTMLElement>('[role="dialog"][id]');
  const popoverTrigger = popover ? document.querySelector<HTMLElement>(`[aria-controls="${popover.id}"]`) : null;
  return { element, popoverTrigger, fromLayer: !element || element !== focusedElement() || !!popoverTrigger };
}

/**
 * The enclosing `Dialog`: whether it is open and modal, what had focus when it opened, and whether Radix
 * has asked it to close (Escape, Close, an outside click). Undefined outside a `Dialog`.
 */
const DialogRootContext = React.createContext<
  { open: boolean; modal: boolean; opener: Opener; closeRequested: React.RefObject<boolean> } | undefined
>(undefined);

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
  modal = true,
  children,
  ...props
}: React.ComponentProps<typeof RadixDialog.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const actualOpen = open ?? uncontrolledOpen;
  const [opening, setOpening] = React.useState(() => ({
    open: actualOpen,
    opener: actualOpen ? currentOpener() : NO_OPENER,
  }));
  if (opening.open !== actualOpen) {
    setOpening({ open: actualOpen, opener: actualOpen ? currentOpener() : opening.opener });
  }
  // A close Radix asked for (Escape, Close, an outside click). The owner may answer by removing the whole
  // dialog instead of passing `open={false}`; `DialogContent` reads this to tell that from a teardown.
  const closeRequested = React.useRef(false);
  React.useLayoutEffect(() => {
    if (actualOpen) closeRequested.current = false;
  }, [actualOpen]);
  const handleOpenChange = (next: boolean) => {
    closeRequested.current = !next;
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const root = React.useMemo(() => ({ ...opening, modal, closeRequested }), [opening, modal]);
  return (
    <DialogRootContext.Provider value={root}>
      <RadixDialog.Root {...props} modal={modal} open={actualOpen} onOpenChange={handleOpenChange}>
        {children}
      </RadixDialog.Root>
    </DialogRootContext.Provider>
  );
}

export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogPortal = RadixDialog.Portal;
export const DialogOverlay = RadixDialog.Overlay;
export const DialogTitle = RadixDialog.Title;
/** Unstyled Radix content for drawers and sheets; `DialogContent` below is the centred card. */
export const DialogPrimitiveContent = RadixDialog.Content;

/** Where focus goes when the dialog closes: the first of these that can take it (see `returnOrder`). */
interface ReturnTargets extends Opener {
  /** Where focus was handed while the dialog was open: the trigger of the menu or popover that opened it. */
  handedTo: HTMLElement | null;
}

/**
 * A dialog opened from a menu or popover returns to where that layer handed focus back, then to the
 * opener. A dialog opened from the page (the editor, a toolbar button) returns to that opener; focus
 * that some other closing menu handed around while it was open is only a fallback.
 */
function returnOrder({ handedTo, element, popoverTrigger, fromLayer }: ReturnTargets) {
  return fromLayer ? [handedTo, element, popoverTrigger] : [element, handedTo, popoverTrigger];
}

const NO_RETURN_TARGETS: ReturnTargets = { handedTo: null, ...NO_OPENER };

/** Another dialog, or a menu, list or popover floating above the page: focus going there is not a hand-back. */
const FLOATING_LAYER = '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

/**
 * Mounted with the dialog body. Records the opener: the one the `Dialog` root saw, or (for a
 * `DialogContent` used without one) whatever has focus now.
 *
 * A menu or popover that closed as the dialog opened hands focus back to its trigger after the dialog has
 * it: Radix one task later, the ⋮ menu once it has finished closing, up to about 170 ms after it opened.
 * While a modal dialog is open that trigger is
 * remembered (it is the place to return to when the opener is gone by close time, as the people popover's
 * own button is, or when two buttons share the menu, as Publish and its arrow do) and focus stays in the
 * dialog. Radix's focus trap keeps it there only once it has seen focus move inside the dialog, and it
 * has not when the first control took focus through `autoFocus`, so typing and Escape went to the
 * trigger behind the dialog (#1349).
 *
 * One task after opening, focus that ended up on <body> is brought back to the first control.
 */
function OpeningFocus({
  contentRef,
  returnRef,
  onGone,
}: {
  contentRef: React.RefObject<HTMLDivElement | null>;
  returnRef: React.RefObject<ReturnTargets>;
  /** The body has unmounted; Radix reports that (`onCloseAutoFocus`) one task later. */
  onGone: (targets: ReturnTargets) => void;
}) {
  const root = React.useContext(DialogRootContext);
  const modal = root?.modal ?? true;
  const [opener] = React.useState(() => (root?.opener.element ? root.opener : currentOpener()));
  React.useLayoutEffect(() => {
    returnRef.current = { handedTo: null, ...opener };
    return () => onGone(returnRef.current);
  }, [opener, returnRef, onGone]);
  React.useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onFocusOut = (e: FocusEvent) => {
      const from = e.target;
      const to = e.relatedTarget;
      if (!(to instanceof HTMLElement) || content.contains(to) || to.closest(FLOATING_LAYER)) return;
      if (!returnRef.current.handedTo) returnRef.current = { ...returnRef.current, handedTo: to };
      // Taking focus back while it is leaving stops the move, the way Radix's own trap does.
      if (from instanceof HTMLElement) from.focus({ preventScroll: true });
    };
    if (modal) content.addEventListener("focusout", onFocusOut);
    const timer = setTimeout(() => {
      if (!content.isConnected || content.contains(document.activeElement)) return;
      (firstTabbable(content) ?? content).focus({ preventScroll: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      content.removeEventListener("focusout", onFocusOut);
    };
  }, [contentRef, returnRef, modal]);
  return null;
}

export function DialogContent({
  title,
  description,
  children,
  className,
  closeButtonClassName,
  wide,
  onClosed,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  closeButtonClassName?: string;
  wide?: boolean;
  /**
   * Runs once the closed dialog has let go of focus. An action that must leave focus in the editor
   * (insert a table, apply a link) belongs here rather than in the button's onClick: while the modal
   * is still mounted its focus trap pulls focus straight back into the dialog, and on unmount focus
   * goes to the opener - the toolbar button, so the next keystroke went to the button (task #437).
   *
   * Runs only after a close: `open` turned false, or Escape, Close or an outside click asked for it and
   * the owner removed the dialog. It does not run when the dialog goes away while still open (the page
   * unmounts, or this `DialogContent` is replaced through its `key`), so a staged action never fires
   * during teardown or under a dialog that is still showing. Focus goes back to the opener either way.
   */
  onClosed?: () => void;
}) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // The body element last on the page; still known while it unmounts, when `contentRef` is already empty.
  const lastContentRef = React.useRef<HTMLDivElement | null>(null);
  const setContent = React.useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (node) lastContentRef.current = node;
  }, []);
  const returnRef = React.useRef(NO_RETURN_TARGETS);
  // What a body that has unmounted leaves for `onCloseAutoFocus`: where focus returns, and the callback
  // to run when that was a close. Taken when it unmounts and kept per body element, because Radix reports
  // the close in a later task, and the dialog may be open again (with its own way back and its own
  // callback) by then, or even open and closed again: the browser holds that task back while keys
  // keep coming.
  const [gone] = React.useState(() => new WeakMap<EventTarget, { targets: ReturnTargets; onClosed: (() => void) | undefined }>());
  const root = React.useContext(DialogRootContext);
  const open = root?.open ?? true;
  // Close runs the callback from the last render while the dialog was open. A caller may hand a new
  // callback to its closing render (the Image dialog's carries a per-render close token, and only the
  // open one may insert the image).
  const onClosedRef = React.useRef(onClosed);
  const openRef = React.useRef(open);
  React.useLayoutEffect(() => {
    openRef.current = open;
    if (open) onClosedRef.current = onClosed;
  }, [open, onClosed]);
  const closeRequested = root?.closeRequested;
  const onGone = React.useCallback(
    (targets: ReturnTargets) => {
      const content = lastContentRef.current;
      const closed = !closeRequested || !openRef.current || closeRequested.current;
      if (content) gone.set(content, { targets, onClosed: closed ? onClosedRef.current : undefined });
    },
    [gone, closeRequested],
  );
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={OVERLAY_CLASS_NAME} />
      <RadixDialog.Content
        ref={setContent}
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
          const body = e.target ? gone.get(e.target) : undefined;
          if (!e.target || !body) return;
          gone.delete(e.target);
          // Only the newest body may move focus. The report of an earlier one can arrive after the
          // dialog has opened and closed again; its way back is out of date then.
          if (e.target === lastContentRef.current) returnOrder(body.targets).some((target) => restoreFocus(target));
          body.onClosed?.();
        }}
      >
        <OpeningFocus contentRef={contentRef} returnRef={returnRef} onGone={onGone} />
        <div className={HEADER_CLASS_NAME} data-focus-skip>
          <div className={TITLE_GROUP_CLASS_NAME}>
            <RadixDialog.Title className={TITLE_CLASS_NAME}>{title}</RadixDialog.Title>
            {description !== undefined ? (
              <RadixDialog.Description className={DESCRIPTION_CLASS_NAME}>{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description className={HIDDEN_DESCRIPTION_CLASS_NAME}>{title}</RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close type="button" className={cn(CLOSE_CLASS_NAME, closeButtonClassName)} aria-label="Close">
            <X size={16} />
          </RadixDialog.Close>
        </div>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
