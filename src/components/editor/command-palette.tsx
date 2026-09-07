"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, ChevronLeft, ChevronRight, Code, Columns2, Copy, CornerDownLeft, Download, Eye,
  FileCode2, FilePlus2, FileText, Files, Hash, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard,
  LayoutTemplate, Link, List, ListChecks, ListOrdered, ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine,
  Quote, Radio, Redo2, Replace, Search, Share2, SquareCode, Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users, type LucideIcon,
} from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { focusedElement, restoreFocus } from "@/lib/a11y";
import { apiErrorText } from "@/lib/api";
import { cn, shortcut } from "@/lib/utils";
import { filterCommands, groupCommands, loadRecent, pushRecent, saveRecent, withRecentFirst, type Command } from "./commands";

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, Code, Columns2, Copy, Download, Eye, FileCode2, FilePlus2, FileText, Files, Hash,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard, LayoutTemplate, Link, List, ListChecks, ListOrdered,
  ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine, Quote, Radio, Redo2, Replace, Search, Share2, SquareCode,
  Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users,
};

interface Level {
  title: string | null;
  items: Command[];
}

interface ChildLoad {
  command: Command;
  retry: boolean;
}

interface ChildLoadError {
  command: Command;
  message: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called on every open so the list reflects the current editor state. */
  commands: () => Command[];
  /** Group display order for the root list. */
  groupOrder?: readonly string[];
  placeholder?: string;
}

function CommandIcon({ name }: { name?: string }) {
  const Icon = name ? ICONS[name] : undefined;
  if (!Icon) return <span className="inline-block h-4 w-4" aria-hidden />;
  return <Icon size={16} className="shrink-0 text-ink-3" aria-hidden />;
}

export const CommandPalette = memo(function CommandPalette({ open, onOpenChange, commands, groupOrder, placeholder = "Type a command…" }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [stack, setStack] = useState<Level[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [childLoad, setChildLoad] = useState<ChildLoad | null>(null);
  const [childError, setChildError] = useState<ChildLoadError | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  const childRequestIdRef = useRef(0);
  const childRequestRef = useRef<{ id: number; command: Command } | null>(null);
  // Command picked but not yet run: it fires from onCloseAutoFocus, once the dialog has handed focus back.
  const pendingRef = useRef<Command | null>(null);
  // Element focused before the palette opened (editor pane, header button). Radix's modal content
  // hands focus to its Trigger on close; the palette has none, so without this focus falls to <body>.
  const returnRef = useRef<HTMLElement | null>(null);

  const invalidateChildLoad = useCallback(() => {
    childRequestIdRef.current += 1;
    childRequestRef.current = null;
  }, []);

  const clearChildLoad = useCallback(() => {
    invalidateChildLoad();
    setChildLoad(null);
    setChildError(null);
  }, [invalidateChildLoad]);

  useLayoutEffect(() => {
    openRef.current = open;
    if (!open) clearChildLoad();
  }, [open, clearChildLoad]);

  useEffect(() => {
    clearChildLoad();
    if (!open) return;
    setQuery("");
    setHighlight(0);
    setRecent(loadRecent());
    setStack([{ title: null, items: commands() }]);
  }, [open, commands, clearChildLoad]);

  const level = stack[stack.length - 1];
  const atRoot = stack.length <= 1;
  const trimmed = query.trim();

  const visible = useMemo(() => {
    if (!level) return [];
    const matched = filterCommands(query, level.items);
    return !trimmed && atRoot ? withRecentFirst(matched, recent) : matched;
  }, [level, query, trimmed, atRoot, recent]);

  // Group headers only when browsing; a typed query shows one ranked list.
  const sections = useMemo(() => (trimmed ? [{ group: null as string | null, items: visible }] : groupCommands(visible, groupOrder)), [visible, trimmed, groupOrder]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => {
    setHighlight(0);
  }, [query, stack]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, flat]);

  const changeOpen = useCallback(
    (next: boolean) => {
      if (!next) clearChildLoad();
      onOpenChange(next);
    },
    [clearChildLoad, onOpenChange],
  );

  const close = useCallback(() => changeOpen(false), [changeOpen]);

  const loadChildren = useCallback((cmd: Command, retry = false) => {
    const provider = cmd.children;
    if (!provider || childRequestRef.current?.command.id === cmd.id) return;

    const request = ++childRequestIdRef.current;
    childRequestRef.current = { id: request, command: cmd };
    setChildLoad({ command: cmd, retry });
    if (!retry) setChildError(null);

    const isCurrent = () => {
      const current = childRequestRef.current;
      return openRef.current && current?.id === request && current.command.id === cmd.id;
    };

    void Promise.resolve()
      .then(() => provider())
      .then((items) => {
        if (!isCurrent()) return;
        childRequestRef.current = null;
        setChildLoad(null);
        setChildError(null);
        setStack((s) => [...s, { title: cmd.title.replace(/…$/, ""), items }]);
        setQuery("");
        inputRef.current?.focus();
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        childRequestRef.current = null;
        setChildLoad(null);
        const title = cmd.title.replace(/…$/, "").trim();
        setChildError({ command: cmd, message: apiErrorText(error, `Could not load ${title || "commands"}`) });
        inputRef.current?.focus();
      });
  }, []);

  const pick = useCallback(
    (cmd: Command) => {
      if (childError?.command.id === cmd.id) return;
      if (cmd.children) {
        loadChildren(cmd);
        return;
      }
      clearChildLoad();
      const next = pushRecent(recent, cmd.id);
      saveRecent(next);
      setRecent(next);
      // Run after the dialog unmounts and restores focus, so a command that opens another dialog
      // (Share, Image, …) captures the editor — not the palette — as the element to return focus to.
      pendingRef.current = cmd;
      close();
    },
    [childError, loadChildren, clearChildLoad, recent, close],
  );

  const back = useCallback(() => {
    clearChildLoad();
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    setQuery("");
  }, [clearChildLoad]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) setHighlight((h) => (h + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setHighlight((h) => (h - 1 + flat.length) % flat.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(Math.max(0, flat.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = flat[highlight];
      if (cmd) void pick(cmd);
    } else if (e.key === "Backspace" && !query && !atRoot) {
      e.preventDefault();
      back();
    }
  };

  let index = -1;
  const retrying = !!childError && childLoad?.retry === true && childLoad.command.id === childError.command.id;
  return (
    <RadixDialog.Root open={open} onOpenChange={changeOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay animate-fade-in" />
        <RadixDialog.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[min(92vw,600px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/20 outline-none animate-fade-in"
          aria-label="Command palette"
          data-testid="command-palette"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            returnRef.current = focusedElement();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const cmd = pendingRef.current;
            pendingRef.current = null;
            // Restore focus first so a command that opens another dialog (Share, Image, …) captures
            // the editor — not the palette — as the element that dialog returns focus to.
            restoreFocus(returnRef.current);
            returnRef.current = null;
            if (cmd) setTimeout(() => void cmd.run(), 0);
          }}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">Search every action, heading and recent document.</RadixDialog.Description>
          <div className="flex items-center gap-2 border-b border-line px-3">
            {atRoot ? (
              <Search size={16} className="shrink-0 text-ink-3" aria-hidden />
            ) : (
              <button type="button" className="icon-btn -ml-1 h-7 w-7" onClick={back} aria-label="Back" data-testid="palette-back">
                <ChevronLeft size={16} />
              </button>
            )}
            {!atRoot && level?.title && <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-xs font-medium text-ink-2">{level.title}</span>}
            <input
              ref={inputRef}
              className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4"
              placeholder={atRoot ? placeholder : "Filter…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-list"
              aria-activedescendant={flat[highlight] ? `palette-item-${flat[highlight].id}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              data-testid="palette-input"
            />
            <Kbd>Esc</Kbd>
          </div>
          {childError && (
            <div className="mx-1.5 mt-1.5 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
              <span className="min-w-0 flex-1">{childError.message}</span>
              <button
                type="button"
                className="btn btn-sm btn-outline shrink-0"
                onClick={() => loadChildren(childError.command, true)}
                disabled={retrying}
                aria-busy={retrying || undefined}
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          <div
            ref={listRef}
            id="command-palette-list"
            role="listbox"
            aria-label="Commands"
            aria-busy={!!childLoad || undefined}
            className="scrollbar-thin max-h-[min(60vh,420px)] overflow-y-auto p-1.5"
          >
            {childLoad && !childError && (
              <div className="px-3 py-3 text-center text-sm text-ink-3" role="status" aria-live="polite" aria-atomic="true">
                Loading…
              </div>
            )}
            {flat.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-ink-3" data-testid="palette-empty">
                No matching commands
              </div>
            ) : (
              sections.map((s, si) => (
                <div key={s.group ?? `q-${si}`} role="group" aria-label={s.group ?? undefined}>
                  {s.group && <div className="menu-label">{s.group}</div>}
                  {s.items.map((cmd) => {
                    index += 1;
                    const i = index;
                    const selected = i === highlight;
                    const unavailable = childLoad?.command.id === cmd.id || childError?.command.id === cmd.id;
                    return (
                      <div
                        key={cmd.id}
                        id={`palette-item-${cmd.id}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={unavailable || undefined}
                        data-index={i}
                        data-testid={`palette-item-${cmd.id}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink select-none",
                          selected && "bg-surface-3",
                          unavailable && "cursor-default opacity-60",
                        )}
                        onMouseEnter={() => setHighlight(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(cmd)}
                      >
                        <CommandIcon name={cmd.icon} />
                        <span className="flex-1 truncate">{cmd.title}</span>
                        {cmd.shortcut && <Kbd>{shortcut(cmd.shortcut)}</Kbd>}
                        {cmd.children && <ChevronRight size={14} className="text-ink-4" aria-hidden />}
                        {selected && !cmd.children && <CornerDownLeft size={13} className="text-ink-4" aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
});

// The dashboard imports the shortcut test together with the palette; the editor shell takes it from
// `./palette-shortcut` directly so its keydown handler does not pin this module to the route's entry JS.
export { isPaletteShortcut } from "./palette-shortcut";
