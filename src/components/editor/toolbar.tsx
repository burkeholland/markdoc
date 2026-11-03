"use client";

import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
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
  SquarePlay,
  Video,
  MessageSquarePlus,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { rovingIndex } from "@/lib/a11y";
import { shallowEqual, useSessionValue } from "./use-session";
import { TOOLBAR_BOX } from "./chrome-classes";
import { useEnterOnRelease, usePickOnRelease, usePlaceHold } from "./press-once";

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
        className={cn("icon-btn tap-target relative", ariaDisabled && "cursor-default opacity-40 hover:bg-transparent hover:text-ink-2")}
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
  onVideo,
  onCard,
  onTable,
}: {
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  onComment: () => void;
  onImage: () => void;
  onVideo: () => void;
  /** Opens "Video or post from a link" (#2317). */
  onCard: () => void;
  onTable: () => void;
}) {
  const { canEdit, canUndo, canRedo, canCreateComment } = useSessionValue(
    session,
    (s) => ({
      canEdit: s.canEdit,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      canCreateComment: s.canCreateComment,
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
        return session.canCreateComment;
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
  useLayoutEffect(syncTabStops);
  useToolbarOverflow(rootRef);

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
    // A named region so landmark navigation reaches the toolbar (axe `region`, #2397); `contents` keeps the layout.
    <section aria-label="Formatting toolbar" className="contents">
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
              className="icon-btn tap-target relative w-auto gap-1 px-2.5 font-semibold"
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
            onKeyDown={pickOnRelease.onMenuKeyDown}
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
        <ToolButton label="Upload video" disabled={dis} onClick={run("edit", onVideo)} testId="tb-video">
          <Video size={18} />
        </ToolButton>
        <ToolButton label="Video or post from a link" disabled={dis} onClick={run("edit", onCard)} testId="tb-card">
          <SquarePlay size={18} />
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
      {canCreateComment && (
        <Tip label="Add comment" shortcut={shortcut("Mod-Alt-M")}>
          <button
            type="button"
            className={cn("btn btn-sm tap-target relative gap-1.5", format.hasSelection ? "btn-outline text-ink" : "btn-ghost text-ink-3")}
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
    </section>
  );
});

/**
 * Marks which edges of a horizontally scrolling toolbar hide buttons (`data-overflow="start|end|both"`),
 * so the CSS fades only those edges and phones see there is more to scroll to (#2399).
 */
export function useToolbarOverflow(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      const value = start && end ? "both" : start ? "start" : end ? "end" : null;
      if (value) el.dataset.overflow = value;
      else delete el.dataset.overflow;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [ref]);
}
