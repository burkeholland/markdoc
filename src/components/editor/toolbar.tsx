"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Italic,
  Link as LinkIcon,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Image as ImageIcon,
  Table,
  Minus,
  Undo2,
  Redo2,
  ChevronDown,
  Heading,
  Strikethrough,
  SquareCode,
  MessageSquarePlus,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { rovingIndex } from "@/lib/a11y";
import { shallowEqual, useSessionValue } from "./use-session";
import { TOOLBAR_BOX } from "./chrome-classes";

/**
 * One press is one action, for the formatting toolbar, the selection bubble and the table menu.
 *
 * Their actions hand focus to the editor. A held key then keeps firing where focus went: a held Enter
 * on Bold formats the selection once and the repeats replace it with empty paragraphs. And the rest of
 * a double-click lands on whatever is under the pointer once a click has closed the menu or hidden the
 * control it was aimed at.
 */

export interface ReleasePress {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  onBlur: () => void;
}

/**
 * Enter clicks a button when the key is released, as Space already does. Put the handlers on the element
 * that holds the buttons.
 *
 * A native button clicks on every keydown of a held Enter. Here each Enter keydown on a button is
 * cancelled, and the keyup clicks the button if the press started on it and focus stayed on it. Enter
 * with Ctrl, Alt or Meta does nothing, and a click that comes with no key (a screen reader, voice
 * control) is not touched.
 */
export function useEnterOnRelease(): ReleasePress {
  const pressed = useRef<HTMLButtonElement | null>(null);
  return {
    onKeyDown(event) {
      const button = event.target;
      if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (!(button instanceof HTMLButtonElement) || !event.currentTarget.contains(button)) return;
      event.preventDefault();
      if (event.repeat) return;
      pressed.current = event.altKey || event.ctrlKey || event.metaKey ? null : button;
    },
    onKeyUp(event) {
      if (event.key !== "Enter") return;
      const button = pressed.current;
      pressed.current = null;
      if (button && button === event.target && button === document.activeElement) button.click();
    },
    onBlur() {
      pressed.current = null;
    },
  };
}

/** Radix collects typed characters for this long to find an item by name. */
const TYPEAHEAD_MS = 1000;

/**
 * Enter and Space pick a menu item when the key is released. Put the handlers on every item of one menu.
 *
 * Radix picks on keydown: the menu closes, focus goes back to the editor and the repeats of a held key
 * are typed there. A repeat that reaches an item, from a key held since before the menu opened, picks
 * nothing either. A space typed as part of an item's name ("heading 2") is left to Radix.
 */
export function usePickOnRelease(): ReleasePress {
  const pressed = useRef<{ item: HTMLElement; key: string } | null>(null);
  const typedAt = useRef(Number.NEGATIVE_INFINITY);
  return {
    onKeyDown(event) {
      if (event.defaultPrevented || event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
      if (event.key !== "Enter" && event.key !== " ") {
        if (event.key.length === 1 && !(event.altKey || event.ctrlKey || event.metaKey)) typedAt.current = event.timeStamp;
        return;
      }
      if (event.key === " " && event.timeStamp - typedAt.current < TYPEAHEAD_MS) return;
      event.preventDefault();
      if (!event.repeat) pressed.current = { item: event.currentTarget, key: event.key };
    },
    onKeyUp(event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      const press = pressed.current;
      pressed.current = null;
      if (press && press.key === event.key && press.item === event.currentTarget) press.item.click();
    },
    onBlur() {
      pressed.current = null;
    },
  };
}

/** Longer than the 500 ms within which Windows counts two clicks as a double-click. */
const HOLD_MS = 600;
/** A press that stays down on the box keeps it at most this long. */
const PRESS_CAP_MS = 10_000;

interface Held {
  control: Element;
  left: number;
  top: number;
  width: number;
  height: number;
  pressed: boolean;
}

/**
 * Keeps the place of a control for the rest of the pointer gesture that removed it.
 *
 * `arm` goes in the click handler of the control's buttons and remembers where the control is. While
 * `gone` is true, `shield` is an empty box over that area, so the second click of a double-click, or a
 * second tap, lands on the box and not on what was under the control. The box does nothing; it cancels
 * its own mousedown, so focus and selection stay where the action left them, and keeps its press from
 * the rest of the page. It is not focusable and not announced.
 *
 * The box leaves HOLD_MS after the click, or after the last press on it ends; at once when the pointer
 * presses anything else; and when the control comes back. A click from the keyboard never arms it.
 */
export function usePlaceHold(gone: boolean): { arm: (event: MouseEvent, control: Element | null | undefined) => void; shield: ReactNode } {
  const [held, setHeld] = useState<Held | null>(null);
  const shieldRef = useRef<HTMLDivElement | null>(null);
  const wasGone = useRef(false);

  useEffect(() => {
    if (!held) return;
    if (gone) wasGone.current = true;
    else if (wasGone.current) {
      setHeld(null);
      return;
    }
    const timer = window.setTimeout(() => setHeld(null), held.pressed ? PRESS_CAP_MS : HOLD_MS);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target === shieldRef.current) setHeld({ ...held, pressed: true });
      else if (!(target instanceof Node && held.control.contains(target))) setHeld(null);
    };
    // A press that went down on the box can end anywhere; a touch ends with pointercancel when it scrolls.
    const onPointerEnd = () => {
      if (held.pressed) setHeld({ ...held, pressed: false });
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
    };
  }, [held, gone]);

  const arm = (event: MouseEvent, control: Element | null | undefined) => {
    // A click from the keyboard, or one sent by assistive technology, has no pointer and `detail` 0.
    if (event.detail === 0 || !control) return;
    const { left, top, width, height } = control.getBoundingClientRect();
    wasGone.current = false;
    setHeld({ control, left, top, width, height, pressed: false });
  };

  // The top layer puts the box over everything, as the bubble and an open dialog are. A press on the box
  // goes no further: the comment sheet a phone opens for Comment closes on a press outside it, and its
  // listener is on the document, where React's own handlers run too late to keep the press from it.
  const attach = useCallback((element: HTMLDivElement | null) => {
    shieldRef.current = element;
    if (!element) return;
    element.addEventListener("pointerdown", (event) => event.stopPropagation());
    if (typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
  }, []);

  const shield =
    held && gone
      ? createPortal(
          <div
            ref={attach}
            popover="manual"
            aria-hidden="true"
            data-testid="place-hold"
            onMouseDown={(event) => event.preventDefault()}
            style={{
              position: "fixed",
              inset: "auto",
              left: held.left,
              top: held.top,
              width: held.width,
              height: held.height,
              margin: 0,
              border: 0,
              padding: 0,
              overflow: "hidden",
              background: "transparent",
              pointerEvents: "auto",
              zIndex: 2147483647,
            }}
          />,
          document.body,
        )
      : null;

  return { arm, shield };
}

/** A button that is off: `disabled`, or `aria-disabled` for the ones that stay focusable. */
const isOff = (button: HTMLButtonElement) => button.disabled || button.getAttribute("aria-disabled") === "true";

function ToolButton({
  label,
  keys,
  active,
  disabled,
  ariaDisabled,
  onClick,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  /**
   * Off, but still a real button: Undo and Redo switch off under the pointer or the focus that has just
   * used them. A `disabled` button lets the rest of a double-click through to the toolbar, which takes
   * focus from the editor, and drops focus to the page when it is the focused one.
   */
  ariaDisabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined}>
      <button
        type="button"
        className={cn("icon-btn", ariaDisabled && "cursor-default opacity-40 hover:bg-transparent hover:text-ink-2")}
        data-active={active ? "true" : undefined}
        disabled={disabled}
        aria-disabled={ariaDisabled || undefined}
        // Keep the editor's selection: the click formats what was selected, not the button.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

function Divider() {
  return <span className="tb-divider mx-1.5 h-6 w-px bg-line" aria-hidden />;
}

/** A run of related buttons. Plain inline flow today; the brand candidates draw it as a hairline pill. */
function Group({ children }: { children: React.ReactNode }) {
  return <span className="tb-group flex items-center gap-0.5">{children}</span>;
}

const HEADINGS = [
  { value: "0", label: "Paragraph", className: "text-[15px]" },
  { value: "1", label: "Heading 1", className: "text-[22px] font-bold" },
  { value: "2", label: "Heading 2", className: "text-[19px] font-bold" },
  { value: "3", label: "Heading 3", className: "text-[17px] font-semibold" },
  { value: "4", label: "Heading 4", className: "text-[15px] font-semibold" },
  { value: "5", label: "Heading 5", className: "text-[14px] font-semibold" },
  { value: "6", label: "Heading 6", className: "text-[13px] font-semibold" },
];

type Permission = "edit" | "undo" | "redo" | "comment";

export const Toolbar = memo(function Toolbar({
  session,
  actions,
  format,
  onComment,
  onImage,
  onTable,
}: {
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  onComment: () => void;
  onImage: () => void;
  onTable: () => void;
}) {
  const { canEdit, canUndo, canRedo, canComment } = useSessionValue(
    session,
    (s) => ({
      canEdit: s.canEdit,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      canComment: s.canComment,
    }),
    shallowEqual,
  );
  const dis = !canEdit;

  // Permissions are read from the session at click time, so a click that lands between a role change
  // and the re-render that disables the button does nothing.
  const allowed = (permission: Permission) => {
    switch (permission) {
      case "edit":
        return session.canEdit;
      case "undo":
        return session.canEdit && session.canUndo;
      case "redo":
        return session.canEdit && session.canRedo;
      case "comment":
        return session.canComment;
    }
  };
  const run = (permission: Permission, action: () => void) => () => {
    if (allowed(permission)) action();
  };

  // Roving tabindex: the toolbar is one tab stop. ←/→ (wrapping) and Home/End move between the enabled
  // buttons; the last-used button keeps tabindex=0 so tabbing back in lands on it. The buttons do not
  // take a tabIndex prop, so React never fights the values written here.
  const rootRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLButtonElement | null>(null);
  const enabledButtons = useCallback(
    () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []).filter((b) => !isOff(b)),
    [],
  );
  const syncTabStops = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const enabled = enabledButtons();
    const last = lastRef.current;
    const stop = last && enabled.includes(last) ? last : enabled[0];
    for (const b of root.querySelectorAll<HTMLButtonElement>("button")) b.tabIndex = b === stop ? 0 : -1;
  }, [enabledButtons]);
  useLayoutEffect(() => {
    syncTabStops();
    // The focused button was switched off (editing was revoked): the caret goes back to the document
    // instead of focus falling to the page.
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && focused.disabled && rootRef.current?.contains(focused)) actions.focus();
  });

  const onToolbarFocus = (e: FocusEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !rootRef.current?.contains(btn)) return;
    lastRef.current = btn;
    syncTabStops();
  };

  const enterOnRelease = useEnterOnRelease();
  const onToolbarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys from the portaled Text style menu bubble here through the React tree; they belong to the menu.
    if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
    enterOnRelease.onKeyDown(e);
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
    const items = enabledButtons();
    let current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      // Focus sits on a button that is switched off (Undo after the last undo): move on from its place.
      const all = Array.from(e.currentTarget.querySelectorAll("button"));
      const before = all.slice(0, all.indexOf(document.activeElement as HTMLButtonElement)).filter((b) => !isOff(b)).length;
      current = e.key === "ArrowRight" ? before - 1 : before;
    }
    const next = rovingIndex(e.key, current, items.length, { orientation: "horizontal", wrap: true });
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  // Text style menu: Radix opens it on Enter, Space and ↓ (first item). ↑ opens it on the last item.
  const [headingOpen, setHeadingOpen] = useState(false);
  const focusLastHeading = useRef(false);
  const pickOnRelease = usePickOnRelease();
  // A pointer pick closes the menu under the pointer: its place is kept for the rest of the gesture.
  const menuHold = usePlaceHold(!headingOpen);
  const onHeadingKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // A held key opens the menu once: its repeats would close it again, or pick the first item.
    if (e.repeat && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      return;
    }
    if (e.key !== "ArrowUp" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
    if (!allowed("edit")) return;
    e.preventDefault();
    focusLastHeading.current = true;
    setHeadingOpen(true);
  };
  const onHeadingOpenChange = (open: boolean) => {
    if (!open) focusLastHeading.current = false;
    setHeadingOpen(open && session.canEdit);
  };
  // Radix enters a menu opened from the keyboard on its first item. After ↑, move on to the last one.
  const onHeadingContentFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (!focusLastHeading.current || (e.target as HTMLElement).getAttribute("role") !== "menuitemradio") return;
    focusLastHeading.current = false;
    const items = e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]:not([data-disabled])");
    items[items.length - 1]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={rootRef}
      className={TOOLBAR_BOX}
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      data-testid="toolbar"
      onFocus={onToolbarFocus}
      onBlur={enterOnRelease.onBlur}
      onKeyDown={onToolbarKeyDown}
      onKeyUp={enterOnRelease.onKeyUp}
    >
      <Group>
        <Menu open={headingOpen} onOpenChange={onHeadingOpenChange}>
          <MenuTrigger asChild onKeyDown={onHeadingKeyDown}>
            <button
              type="button"
              className="icon-btn w-auto gap-1 px-2.5 font-semibold"
              disabled={dis}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Text style"
              data-testid="heading-menu"
            >
              <Heading size={18} />
              {/* The level always has its place, so a click that changes it moves no button. */}
              <span className="inline-block w-[1ch] text-center text-xs tabular-nums text-accent">{format.heading > 0 ? format.heading : null}</span>
              <ChevronDown size={14} className="text-ink-4" />
            </button>
          </MenuTrigger>
          <MenuContent
            align="start"
            className="w-56"
            onFocus={onHeadingContentFocus}
            // Radix hands focus back to the trigger when the menu closes; the caret belongs in the editor
            // the moment a style is picked (task #437: Ctrl+Z and typing went to the toolbar button).
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              actions.focus();
            }}
          >
            <MenuRadioGroup value={String(format.heading)}>
              {HEADINGS.map((h) => (
                <MenuRadioItem
                  key={h.value}
                  value={h.value}
                  className={h.className}
                  disabled={dis}
                  onKeyDown={pickOnRelease.onKeyDown}
                  onKeyUp={pickOnRelease.onKeyUp}
                  onBlur={pickOnRelease.onBlur}
                  onClick={(e: MouseEvent<HTMLDivElement>) => menuHold.arm(e, e.currentTarget.closest("[role=menu]"))}
                  onSelect={run("edit", () => actions.setHeading(Number(h.value)))}
                >
                  {h.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bold" keys="Mod-B" active={format.strong} disabled={dis} onClick={run("edit", () => actions.toggleMark("strong"))} testId="tb-bold">
          <Bold size={18} strokeWidth={2.6} />
        </ToolButton>
        <ToolButton label="Italic" keys="Mod-I" active={format.em} disabled={dis} onClick={run("edit", () => actions.toggleMark("em"))} testId="tb-italic">
          <Italic size={18} />
        </ToolButton>
        <ToolButton label="Strikethrough" keys="Mod-Shift-X" active={format.strike} disabled={dis} onClick={run("edit", () => actions.toggleMark("strike"))}>
          <Strikethrough size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Link" keys="Mod-K" active={format.link} disabled={dis} onClick={run("edit", () => actions.openLinkDialog())} testId="tb-link">
          <LinkIcon size={18} />
        </ToolButton>
        <ToolButton label="Inline code" keys="Mod-`" active={format.code} disabled={dis} onClick={run("edit", () => actions.toggleMark("code"))} testId="tb-code">
          <Code size={18} />
        </ToolButton>
        <ToolButton label="Code block" keys="Mod-Alt-C" active={format.codeBlock} disabled={dis} onClick={run("edit", () => actions.toggleCodeBlock())}>
          <SquareCode size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bulleted list" keys="Mod-Shift-8" active={format.bullet} disabled={dis} onClick={run("edit", () => actions.toggleList("bullet"))} testId="tb-bullet">
          <List size={18} />
        </ToolButton>
        <ToolButton label="Numbered list" keys="Mod-Shift-7" active={format.ordered} disabled={dis} onClick={run("edit", () => actions.toggleList("ordered"))} testId="tb-ordered">
          <ListOrdered size={18} />
        </ToolButton>
        <ToolButton label="Task list" keys="Mod-Shift-9" active={format.task} disabled={dis} onClick={run("edit", () => actions.toggleList("task"))} testId="tb-task">
          <ListChecks size={18} />
        </ToolButton>
        <ToolButton label="Quote" keys="Mod-Shift-." active={format.quote} disabled={dis} onClick={run("edit", () => actions.toggleQuote())}>
          <Quote size={18} />
        </ToolButton>
        <ToolButton label="Image" disabled={dis} onClick={run("edit", onImage)} testId="tb-image">
          <ImageIcon size={18} />
        </ToolButton>
        <ToolButton label="Table" disabled={dis} onClick={run("edit", onTable)} testId="tb-table">
          <Table size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Horizontal rule" disabled={dis} onClick={run("edit", () => actions.horizontalRule())}>
          <Minus size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Undo" keys="Mod-Z" disabled={dis} ariaDisabled={!dis && !canUndo} onClick={run("undo", () => actions.undo())} testId="tb-undo">
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton label="Redo" keys="Mod-Shift-Z" disabled={dis} ariaDisabled={!dis && !canRedo} onClick={run("redo", () => actions.redo())} testId="tb-redo">
          <Redo2 size={18} />
        </ToolButton>
      </Group>
      <div className="flex-1" />
      {canComment && (
        <Tip label="Add comment" shortcut={shortcut("Mod-Alt-M")}>
          <button
            type="button"
            className={cn("btn btn-sm gap-1.5", format.hasSelection ? "btn-outline text-ink" : "btn-ghost text-ink-3")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={run("comment", onComment)}
            data-testid="tb-comment"
          >
            <MessageSquarePlus size={16} />
            Comment
          </button>
        </Tip>
      )}
      {menuHold.shield}
    </div>
  );
});
