"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  setKeyHandler: (handler: (key: SlashKey) => boolean) => () => void;
}

export function createSlashMenuController(): SlashMenuController {
  let state: SlashState | null = null;
  let keyOwner: { handler: (key: SlashKey) => boolean } | null = null;
  const listeners = new Set<(state: SlashState | null) => void>();
  return {
    handlers: {
      onState: (next) => {
        state = next;
        for (const l of listeners) l(next);
      },
      onKey: (key) => keyOwner?.handler(key) ?? false,
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    setKeyHandler: (handler) => {
      const owner = { handler };
      keyOwner = owner;
      return () => {
        if (keyOwner === owner) keyOwner = null;
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

type SlashMenuAuthority = {
  controller: SlashMenuController;
  view: EditorView;
  session: CollabSession;
};

type SlashMenuSnapshot = {
  authority: SlashMenuAuthority;
  state: SlashState | null;
};

type HighlightOwner = {
  authority: SlashMenuAuthority;
  query: string;
  index: number;
};

type PositionOwner = {
  snapshot: SlashMenuSnapshot;
  value: { left: number; top: number; width: number; maxHeight: number };
};

type KeyOwner = {
  authority: SlashMenuAuthority;
  retire: () => void;
};

export function SlashMenu({
  view,
  session,
  controller,
  containerRef,
  onImage,
  onLink,
  onComment,
  onKeepAgent,
}: {
  view: EditorView | null;
  session: CollabSession;
  controller: SlashMenuController;
  containerRef: React.RefObject<HTMLElement | null>;
  onImage: () => void;
  onLink: () => void;
  onComment: () => void;
  /** `/agent`: opens the "Keep an agent here" dialog. */
  onKeepAgent: () => void;
}) {
  const authority = useMemo<SlashMenuAuthority | null>(
    () => (view ? { controller, view, session } : null),
    [controller, view, session],
  );
  const authorityRef = useRef<SlashMenuAuthority | null>(null);
  const retiredControllersRef = useRef(new WeakSet<SlashMenuController>());
  const keyOwnerRef = useRef<KeyOwner | null>(null);
  const [snapshot, setSnapshot] = useState<SlashMenuSnapshot | null>(() =>
    authority ? { authority, state: controller.getState() } : null,
  );
  const currentSnapshot = snapshot?.authority === authority ? snapshot : null;
  const state = currentSnapshot?.state ?? null;
  const query = state ? `${state.from}:${state.query}` : "";
  const [highlight, setHighlight] = useState<HighlightOwner | null>(null);
  const index = highlight?.authority === authority && highlight.query === query ? highlight.index : 0;
  const [position, setPosition] = useState<PositionOwner | null>(null);
  const pos = position?.snapshot === currentSnapshot ? position.value : null;
  const listRef = useRef<HTMLDivElement>(null);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const canComment = useSessionValue(session, (s) => s.canComment);

  useLayoutEffect(() => {
    const retiredControllers = retiredControllersRef.current;
    if (!authority) {
      setSnapshot(null);
      return;
    }

    authorityRef.current = authority;
    const publish = (next: SlashState | null) => {
      if (authorityRef.current !== authority) return;
      setSnapshot({ authority, state: next });
    };
    const unsubscribe = controller.subscribe(publish);
    setSnapshot((current) => {
      if (current?.authority === authority) return current;
      // A shared controller still contains the retired view's last publication.
      // Its replacement visit starts closed until that view publishes for itself.
      const retired = current?.authority.controller === controller || retiredControllers.has(controller);
      const next = retired ? null : controller.getState();
      return { authority, state: next };
    });
    return () => {
      retiredControllers.add(controller);
      if (authorityRef.current === authority) authorityRef.current = null;
      const keyOwner = keyOwnerRef.current;
      if (keyOwner?.authority === authority) keyOwner.retire();
      unsubscribe();
    };
  }, [authority, controller]);

  const where: SlashWhere = useMemo(() => ({ inTable: !!(view && state && tableAt(view.state)), canComment }), [view, state, canComment]);
  const items = useMemo(() => (state ? filterSlashItems(state.query, SLASH_ITEMS, where) : []), [state, where]);
  const open = !!state && canEdit && !!view;

  const setCurrentIndex = useCallback(
    (update: (current: number) => number) => {
      if (!authority || authorityRef.current !== authority) return;
      setHighlight((current) => {
        if (authorityRef.current !== authority) return current;
        const value = current?.authority === authority && current.query === query ? current.index : 0;
        const next = update(value);
        if (current?.authority === authority && current.query === query && current.index === next) return current;
        return { authority, query, index: next };
      });
    },
    [authority, query],
  );

  const apply = useCallback(
    (item: SlashItem | undefined) => {
      if (!view || !authority || authorityRef.current !== authority) return;
      const current = controller.getState();
      if (!current || current !== state) return;
      if (!item) return closeSlashMenu(view);
      const arg = splitSlashQuery(current.query).arg;
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
            keepAgent: onKeepAgent,
          };
          item.run(ctx, arg);
        },
        session.undoManager,
      );
    },
    [view, authority, controller, state, where, onImage, onLink, onComment, onKeepAgent, session],
  );
  useLayoutEffect(() => {
    if (!open || !authority || authorityRef.current !== authority) return;
    const previous = keyOwnerRef.current;
    if (previous) previous.retire();

    let active = true;
    const handler = (key: SlashKey) => {
      if (!active || authorityRef.current !== authority || keyOwnerRef.current !== owner) return false;
      if (key === "ArrowDown") setCurrentIndex((i) => (items.length ? (i + 1) % items.length : 0));
      else if (key === "ArrowUp") setCurrentIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
      else apply(items[index]);
      return true;
    };
    const clear = controller.setKeyHandler(handler);
    const owner: KeyOwner = {
      authority,
      retire: () => {
        if (!active) return;
        active = false;
        if (keyOwnerRef.current === owner) keyOwnerRef.current = null;
        clear();
      },
    };
    keyOwnerRef.current = owner;
    return owner.retire;
  }, [open, authority, controller, items, index, apply, setCurrentIndex]);

  // Keep the highlighted row visible while navigating with the keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!open || !state || !currentSnapshot || !container) {
      setPosition((current) => (current?.snapshot === currentSnapshot ? null : current));
      return;
    }
    const host = container.getBoundingClientRect();
    // Rows plus one caption per group shown; short lists used to be cut off because the captions were not counted.
    const groupsShown = new Set(items.map((item) => item.group)).size;
    const listHeight = groupsShown * GROUP_HEADER_HEIGHT + items.reduce((h, item) => h + rowHeight(item), 0);
    const height = Math.min(MENU_MAX_HEIGHT, Math.max(ROW_HEIGHT, listHeight) + 8);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const below = state.coords.bottom + 6 + height <= viewport.height - 8;
    const box = clampToViewport({ left: state.coords.left, top: below ? state.coords.bottom + 6 : state.coords.top - 6 - height, width: MENU_WIDTH, height }, viewport);
    const left = Math.max(8, Math.min(host.width - box.width - 8, box.left - host.left));
    const top = box.top - host.top + container.scrollTop;
    setPosition({ snapshot: currentSnapshot, value: { left, top, width: box.width, maxHeight: box.height } });
  }, [open, state, currentSnapshot, items, containerRef]);

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
                style={{ height: rowHeight(item) }}
                onMouseEnter={() => setCurrentIndex(() => i)}
                onClick={() => apply(item)}
              >
                <Icon size={16} className="shrink-0 text-ink-3" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.title}</span>
                  {item.description && <span className="truncate text-xs text-ink-3">{item.description}</span>}
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
