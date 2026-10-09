"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { Bot, Calendar, Heading1, Heading2, Heading3, Image, Link, List, ListChecks, ListOrdered, MessageSquarePlus, Minus, Quote, SquareCode, Table, Type, type LucideIcon } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { tableAt } from "@/editor/prosemirror/commands";
import { applySlashCommand, applySlashItem, closeSlashMenu, type SlashKey, type SlashMenuHandlers, type SlashState } from "@/editor/prosemirror/slash-menu";
import { SLASH_GROUPS, SLASH_ITEMS, filterSlashItems, splitSlashQuery, type SlashItem, type SlashWhere } from "@/editor/slash-items";
import { cn } from "@/lib/utils";
import { clampToViewport } from "@/lib/viewport";
import { useSessionValue } from "./use-session";

const ICONS: Record<string, LucideIcon> = { Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, SquareCode, Minus, Table, Image, Link, MessageSquarePlus, Calendar, Bot };

const MENU_WIDTH = 288;
const ROW_HEIGHT = 36;
/** Rows with a description line (the `/agent` item). */
const ROW_HEIGHT_TALL = 52;
/** The "Insert" / "Blocks" group caption above each group's rows (pt-1.5 + 16 px line + pb-0.5). */
const GROUP_HEADER_HEIGHT = 24;
const MAX_VISIBLE = 8;
const MENU_MAX_HEIGHT = ROW_HEIGHT * MAX_VISIBLE + 8;

const rowHeight = (item: SlashItem) => (item.description ? ROW_HEIGHT_TALL : ROW_HEIGHT);

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
  /** The mounted menu says how it takes keys. The returned function removes that handler again. */
  setKeyHandler: (handler: (key: SlashKey) => boolean) => () => void;
}

export function createSlashMenuController(): SlashMenuController {
  let state: SlashState | null = null;
  let keyHandler: ((key: SlashKey) => boolean) | null = null;
  const listeners = new Set<(state: SlashState | null) => void>();
  return {
    handlers: {
      onState: (next) => {
        state = next;
        for (const listener of [...listeners]) listener(next);
      },
      // No menu mounted: the key is not taken and goes on to the editor.
      onKey: (key) => keyHandler?.(key) ?? false,
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    setKeyHandler: (handler) => {
      keyHandler = handler;
      return () => {
        // A menu that unmounts late must not remove the handler of the menu that replaced it.
        if (keyHandler === handler) keyHandler = null;
      };
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

const noServerState = () => null;

/**
 * The `/` menu of the rich pane. Plain handlers on purpose (#2334): a key or a click is acted on at
 * once, from the plugin's current state, with no check of how the event or the menu's DOM looks.
 */
export function SlashMenu({
  view,
  session,
  controller,
  containerRef,
  onImage,
  onLink,
  onComment,
  onConnectAgent,
}: {
  view: EditorView | null;
  session: CollabSession;
  controller: SlashMenuController;
  containerRef: React.RefObject<HTMLElement | null>;
  onImage: () => void;
  onLink: () => void;
  onComment: () => void;
  /** `/agent`: opens the "Connect an AI agent" dialog. */
  onConnectAgent: () => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, noServerState);
  const [highlight, setHighlight] = useState(0);
  // What the key handler reads: two arrow presses can arrive before React has rendered the first.
  const highlightRef = useRef(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const canComment = useSessionValue(session, (s) => s.canComment);

  const where: SlashWhere = useMemo(() => ({ inTable: !!(view && state && tableAt(view.state)), canComment }), [view, state, canComment]);
  const items = useMemo(() => (state ? filterSlashItems(state.query, SLASH_ITEMS, where) : []), [state, where]);
  const open = !!state && canEdit && !!view;
  const index = Math.min(highlight, Math.max(0, items.length - 1));

  const moveHighlight = (next: number) => {
    highlightRef.current = next;
    setHighlight(next);
  };

  // The highlighted row lasts while the menu stays open on one query. A new query starts at the first row, and
  // so does a menu that opens again, also at the same place. The row stays when only the place of the "/"
  // moves: that is what another person's typing above it does.
  useLayoutEffect(() => {
    let shown = controller.getState()?.query ?? null;
    return controller.subscribe((next) => {
      const query = next ? next.query : null;
      if (query === shown) return;
      shown = query;
      highlightRef.current = 0;
      setHighlight(0);
    });
  }, [controller]);

  const pick = (item: SlashItem | undefined) => {
    if (!view) return;
    // "No matches" + Enter: the menu closes and the typed text stays.
    if (!item) return closeSlashMenu(view);
    const arg = splitSlashQuery(controller.getState()?.query ?? "").arg;
    if (item.command) {
      // One transaction for the /query removal and the edit: a single undo step.
      applySlashCommand(view, item.command(arg), session.undoManager);
      view.focus();
      return;
    }
    const run = item.run;
    const context = {
      view,
      where: { inTable: !!tableAt(view.state), canComment: session.canComment },
      openImage: onImage,
      openLink: onLink,
      startComment: () => {
        selectCurrentBlock(view);
        onComment();
      },
      connectAgent: onConnectAgent,
    };
    applySlashItem(view, () => run(context, arg), session.undoManager);
  };

  /**
   * Takes a key from the plugin. It reads the plugin's state and the document as they are at this
   * moment, not as React last rendered them, so "/" + "h1" + Enter typed in one burst picks Heading 1.
   */
  const takeKey = (key: SlashKey): boolean => {
    const current = controller.getState();
    if (!view || !current || !session.canEdit) return false;
    const live = filterSlashItems(current.query, SLASH_ITEMS, { inTable: !!tableAt(view.state), canComment: session.canComment });
    const last = Math.max(0, live.length - 1);
    const at = Math.min(highlightRef.current, last);
    if (key === "Enter" || key === "Tab") {
      pick(live[at]);
      return true;
    }
    const count = live.length;
    let next = at;
    if (key === "ArrowDown") next = count ? (at + 1) % count : 0;
    else if (key === "ArrowUp") next = count ? (at - 1 + count) % count : 0;
    else if (key === "Home") next = 0;
    else next = last;
    moveHighlight(next);
    return true;
  };

  // The controller keeps one stable function; it always calls the handler of the latest render.
  const takeKeyRef = useRef(takeKey);
  useLayoutEffect(() => {
    takeKeyRef.current = takeKey;
  });
  useLayoutEffect(() => controller.setKeyHandler((key) => takeKeyRef.current(key)), [controller]);

  // Keep the highlighted row visible while navigating with the keyboard.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const ownerWindow = container?.ownerDocument.defaultView;
    if (!open || !state || !container || !ownerWindow) {
      setPos(null);
      return;
    }
    const host = container.getBoundingClientRect();
    // Rows plus one caption per group shown; short lists used to be cut off because the captions were not counted.
    const groupsShown = new Set(items.map((item) => item.group)).size;
    const listHeight = groupsShown * GROUP_HEADER_HEIGHT + items.reduce((h, item) => h + rowHeight(item), 0);
    const height = Math.min(MENU_MAX_HEIGHT, Math.max(ROW_HEIGHT, listHeight) + 8);
    const viewport = { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight };
    const below = state.coords.bottom + 6 + height <= viewport.height - 8;
    const box = clampToViewport({ left: state.coords.left, top: below ? state.coords.bottom + 6 : state.coords.top - 6 - height, width: MENU_WIDTH, height }, viewport);
    const left = Math.max(8, Math.min(host.width - box.width - 8, box.left - host.left));
    const top = box.top - host.top + container.scrollTop;
    setPos({ left, top, width: box.width, maxHeight: box.height });
  }, [open, state, items, containerRef]);

  if (!open || !pos) return null;

  const groups = SLASH_GROUPS.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((g) => g.items.length > 0);
  const indexOf = new Map(items.map((item, i) => [item.id, i]));

  return (
    <div
      ref={listRef}
      className="touch-target scrollbar-thin absolute z-40 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl animate-fade-in"
      style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: Math.min(MENU_MAX_HEIGHT, pos.maxHeight) }}
      role="listbox"
      aria-label="Insert block"
      data-testid="slash-menu"
      // The editor keeps the focus and the caret while the pointer works in the menu; without this
      // the editor blurs on mousedown and the plugin closes the menu before the click arrives.
      onMouseDown={(event) => event.preventDefault()}
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
                style={{ height: rowHeight(item) }}
                // mousemove, not mouseenter: when the menu opens (or scrolls) under a pointer that rests,
                // the browser sends mouseenter but no mousemove, and the row under it must not be picked by Enter.
                onMouseMove={() => {
                  if (i !== index) moveHighlight(i);
                }}
                onClick={() => pick(item)}
              >
                <Icon size={16} className="shrink-0 text-ink-3" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate" title={item.title}>
                    {item.title}
                  </span>
                  {item.description && (
                    <span className="truncate text-xs text-ink-3" title={item.description}>
                      {item.description}
                    </span>
                  )}
                </span>
                {item.hint && <span className="text-xs text-ink-3">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}