"use client";

import { memo, useCallback, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
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

function ToolButton({
  label,
  keys,
  active,
  disabled,
  onClick,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined}>
      <button
        type="button"
        className="icon-btn"
        data-active={active ? "true" : undefined}
        disabled={disabled}
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
  return <span className="mx-1.5 h-6 w-px bg-line" aria-hidden />;
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

  // Roving tabindex: the toolbar is one tab stop. ←/→ (wrapping) and Home/End move between the enabled
  // buttons; the last-used button keeps tabindex=0 so tabbing back in lands on it. The buttons do not
  // take a tabIndex prop, so React never fights the values written here.
  const rootRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLButtonElement | null>(null);
  const enabledButtons = useCallback(() => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []), []);
  const syncTabStops = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const enabled = enabledButtons();
    const last = lastRef.current;
    const stop = last && !last.disabled && enabled.includes(last) ? last : enabled[0];
    for (const b of root.querySelectorAll<HTMLButtonElement>("button")) b.tabIndex = b === stop ? 0 : -1;
  }, [enabledButtons]);
  useLayoutEffect(syncTabStops);

  const onToolbarFocus = (e: FocusEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !rootRef.current?.contains(btn)) return;
    lastRef.current = btn;
    syncTabStops();
  };

  const onToolbarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const items = enabledButtons();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = rovingIndex(e.key, current, items.length, { orientation: "horizontal", wrap: true });
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="toolbar-scroll safe-x flex h-12 shrink-0 items-center gap-0.5 border-b border-line"
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      data-testid="toolbar"
      onFocus={onToolbarFocus}
      onKeyDown={onToolbarKeyDown}
    >
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="icon-btn w-auto gap-1 px-2.5 font-semibold"
            disabled={dis}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Text style"
            data-testid="heading-menu"
          >
            <Heading size={18} />
            {format.heading > 0 && <span className="text-xs text-accent">{format.heading}</span>}
            <ChevronDown size={14} className="text-ink-4" />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-56">
          <MenuRadioGroup value={String(format.heading)} onValueChange={(v) => actions.setHeading(Number(v))}>
            {HEADINGS.map((h) => (
              <MenuRadioItem key={h.value} value={h.value} className={h.className}>
                {h.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <Divider />
      <ToolButton label="Bold" keys="Mod-B" active={format.strong} disabled={dis} onClick={() => actions.toggleMark("strong")} testId="tb-bold">
        <Bold size={18} strokeWidth={2.6} />
      </ToolButton>
      <ToolButton label="Italic" keys="Mod-I" active={format.em} disabled={dis} onClick={() => actions.toggleMark("em")} testId="tb-italic">
        <Italic size={18} />
      </ToolButton>
      <ToolButton label="Strikethrough" keys="Mod-Shift-X" active={format.strike} disabled={dis} onClick={() => actions.toggleMark("strike")}>
        <Strikethrough size={18} />
      </ToolButton>
      <Divider />
      <ToolButton label="Link" keys="Mod-K" active={format.link} disabled={dis} onClick={() => actions.openLinkDialog()} testId="tb-link">
        <LinkIcon size={18} />
      </ToolButton>
      <ToolButton label="Inline code" keys="Mod-`" active={format.code} disabled={dis} onClick={() => actions.toggleMark("code")} testId="tb-code">
        <Code size={18} />
      </ToolButton>
      <ToolButton label="Code block" keys="Mod-Alt-C" active={format.codeBlock} disabled={dis} onClick={() => actions.toggleCodeBlock()}>
        <SquareCode size={18} />
      </ToolButton>
      <Divider />
      <ToolButton label="Bulleted list" keys="Mod-Shift-8" active={format.bullet} disabled={dis} onClick={() => actions.toggleList("bullet")} testId="tb-bullet">
        <List size={18} />
      </ToolButton>
      <ToolButton label="Numbered list" keys="Mod-Shift-7" active={format.ordered} disabled={dis} onClick={() => actions.toggleList("ordered")} testId="tb-ordered">
        <ListOrdered size={18} />
      </ToolButton>
      <ToolButton label="Task list" keys="Mod-Shift-9" active={format.task} disabled={dis} onClick={() => actions.toggleList("task")} testId="tb-task">
        <ListChecks size={18} />
      </ToolButton>
      <ToolButton label="Quote" keys="Mod-Shift-." active={format.quote} disabled={dis} onClick={() => actions.toggleQuote()}>
        <Quote size={18} />
      </ToolButton>
      <ToolButton label="Image" disabled={dis} onClick={onImage} testId="tb-image">
        <ImageIcon size={18} />
      </ToolButton>
      <ToolButton label="Table" disabled={dis} onClick={onTable} testId="tb-table">
        <Table size={18} />
      </ToolButton>
      <Divider />
      <ToolButton label="Horizontal rule" disabled={dis} onClick={() => actions.horizontalRule()}>
        <Minus size={18} />
      </ToolButton>
      <Divider />
      <ToolButton label="Undo" keys="Mod-Z" disabled={!canEdit || !canUndo} onClick={() => actions.undo()} testId="tb-undo">
        <Undo2 size={18} />
      </ToolButton>
      <ToolButton label="Redo" keys="Mod-Shift-Z" disabled={!canEdit || !canRedo} onClick={() => actions.redo()} testId="tb-redo">
        <Redo2 size={18} />
      </ToolButton>
      <div className="flex-1" />
      {canComment && (
        <Tip label="Add comment" shortcut={shortcut("Mod-Alt-M")}>
          <button
            type="button"
            className={cn("btn btn-sm gap-1.5", format.hasSelection ? "btn-outline text-ink" : "btn-ghost text-ink-3")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onComment}
            data-testid="tb-comment"
          >
            <MessageSquarePlus size={16} />
            Comment
          </button>
        </Tip>
      )}
    </div>
  );
});

