"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { Calendar, Heading1, Heading2, Heading3, Image, Link, List, ListChecks, ListOrdered, MessageSquarePlus, Minus, Quote, SquareCode, Table, Type, type LucideIcon } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { tableAt } from "@/editor/prosemirror/commands";
import { applySlashCommand, applySlashItem, closeSlashMenu, type SlashKey, type SlashMenuHandlers, type SlashState } from "@/editor/prosemirror/slash-menu";
import { SLASH_GROUPS, SLASH_ITEMS, filterSlashItems, splitSlashQuery, type SlashItem, type SlashWhere } from "@/editor/slash-items";
import { cn } from "@/lib/utils";
import { clampToViewport } from "@/lib/viewport";
import { useSessionValue } from "./use-session";

const ICONS: Record<string, LucideIcon> = { Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, SquareCode, Minus, Table, Image, Link, MessageSquarePlus, Calendar };

const MENU_WIDTH = 288;
const ROW_HEIGHT = 36;
const MAX_VISIBLE = 8;
const MENU_MAX_HEIGHT = ROW_HEIGHT * MAX_VISIBLE + 8;

/**
 * Glue between the ProseMirror plugin (which owns the `/query` range and
 * intercepts navigation keys) and the React menu (which owns the filtered
 * list and the highlighted row). Create one per shell and hand `handlers`
 * to the rich pane.
 */
export interface SlashMenuController {
  handlers: SlashMenuHandlers;
  subscribe: (listener: (state: SlashState | null) => void) => () => void;
  getState: () => SlashState | null;
  setKeyHandler: (handler: ((key: SlashKey) => boolean) | null) => void;
}

export function createSlashMenuController(): SlashMenuController {
  let state: SlashState | null = null;
  let keyHandler: ((key: SlashKey) => boolean) | null = null;
  const listeners = new Set<(state: SlashState | null) => void>();
  return {
    handlers: {
      onState: (next) => {
        state = next;
        for (const l of listeners) l(next);
      },
      onKey: (key) => keyHandler?.(key) ?? false,
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    setKeyHandler: (handler) => {
      keyHandler = handler;
    },
  };
}

export function useSlashMenuController(): SlashMenuController {
  return useMemo(() => createSlashMenuController(), []);
}

/** Selects the text of the block around the caret so a comment can anchor to it. */
function selectCurrentBlock(view: EditorView) {
  const { $from } = view.state.selection;
  const start = $from.start();
  const end = $from.end();
  if (end > start) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end)));
}

export function SlashMenu({
  view,
  session,
  controller,
  containerRef,
  onImage,
  onLink,
  onComment,
}: {
  view: EditorView | null;
  session: CollabSession;
  controller: SlashMenuController;
  containerRef: React.RefObject<HTMLElement | null>;
  onImage: () => void;
  onLink: () => void;
  onComment: () => void;
}) {
  const [state, setState] = useState<SlashState | null>(() => controller.getState());
  const [index, setIndex] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const canComment = useSessionValue(session, (s) => s.canComment);

  useEffect(() => controller.subscribe(setState), [controller]);

  const where: SlashWhere = useMemo(() => ({ inTable: !!(view && state && tableAt(view.state)), canComment }), [view, state, canComment]);
  const items = useMemo(() => (state ? filterSlashItems(state.query, SLASH_ITEMS, where) : []), [state, where]);
  const open = !!state && canEdit && !!view;

  // Reset the highlight whenever the query changes.
  useEffect(() => {
    setIndex(0);
  }, [state?.query, state?.from]);

  const apply = useCallback(
    (item: SlashItem | undefined) => {
      if (!view) return;
      if (!item) return closeSlashMenu(view);
      const arg = splitSlashQuery(controller.getState()?.query ?? "").arg;
      if (item.command) {
        // One transaction for the /query removal and the edit: a single undo step.
        applySlashCommand(view, item.command(arg), session.undoManager);
        view.focus();
        return;
      }
      applySlashItem(
        view,
        () => {
          const ctx = {
            view,
            where,
            openImage: onImage,
            openLink: onLink,
            startComment: () => {
              selectCurrentBlock(view);
              onComment();
            },
          };
          item.run(ctx, arg);
        },
        session.undoManager,
      );
    },
    [view, controller, where, onImage, onLink, onComment, session],
  );

  useEffect(() => {
    if (!open) {
      controller.setKeyHandler(null);
      return;
    }
    controller.setKeyHandler((key) => {
      if (key === "ArrowDown") setIndex((i) => (items.length ? (i + 1) % items.length : 0));
      else if (key === "ArrowUp") setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
      else apply(items[index]);
      return true;
    });
    return () => controller.setKeyHandler(null);
  }, [open, controller, items, index, apply]);

  // Keep the highlighted row visible while navigating with the keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!open || !state || !container) {
      setPos(null);
      return;
    }
    const host = container.getBoundingClientRect();
    const height = Math.min(MENU_MAX_HEIGHT, Math.max(1, items.length) * ROW_HEIGHT + 8);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const below = state.coords.bottom + 6 + height <= viewport.height - 8;
    const box = clampToViewport({ left: state.coords.left, top: below ? state.coords.bottom + 6 : state.coords.top - 6 - height, width: MENU_WIDTH, height }, viewport);
    const left = Math.max(8, Math.min(host.width - box.width - 8, box.left - host.left));
    const top = box.top - host.top + container.scrollTop;
    setPos({ left, top, width: box.width, maxHeight: box.height });
  }, [open, state, items.length, containerRef]);

  if (!open || !pos) return null;

  const groups = SLASH_GROUPS.map((g) => ({ group: g, items: items.filter((i) => i.group === g) })).filter((g) => g.items.length > 0);
  const indexOf = new Map(items.map((item, i) => [item.id, i]));

  return (
    <div
      ref={listRef}
      className="touch-target scrollbar-thin absolute z-40 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl animate-fade-in"
      style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: Math.min(MENU_MAX_HEIGHT, pos.maxHeight) }}
      role="listbox"
      aria-label="Insert block"
      data-testid="slash-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length === 0 && (
        <div className="px-3 text-sm text-ink-3" style={{ lineHeight: `${ROW_HEIGHT}px` }} data-testid="slash-empty" role="option" aria-selected>
          No matches
        </div>
      )}
      {groups.map((g) => (
        <div key={g.group}>
          <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{g.group}</div>
          {g.items.map((item) => {
            const i = indexOf.get(item.id) ?? 0;
            const Icon = ICONS[item.icon] ?? Type;
            const active = i === index;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={active}
                data-index={i}
                data-testid={`slash-item-${item.id}`}
                className={cn("flex w-full items-center gap-3 px-3 text-left text-sm text-ink-2", active && "bg-accent-soft text-ink")}
                style={{ height: ROW_HEIGHT }}
                onMouseEnter={() => setIndex(i)}
                onClick={() => apply(item)}
              >
                <Icon size={16} className="shrink-0 text-ink-3" />
                <span className="flex-1 truncate">{item.title}</span>
                {item.hint && <span className="text-xs text-ink-3">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
