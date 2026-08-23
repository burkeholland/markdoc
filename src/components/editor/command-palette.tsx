"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, ChevronLeft, ChevronRight, Code, Columns2, Copy, CornerDownLeft, Download, Eye,
  FileCode2, FilePlus2, FileText, Files, Hash, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard,
  LayoutTemplate, Link, List, ListChecks, ListOrdered, ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine,
  Quote, Redo2, Replace, Search, Share2, SquareCode, Star, Strikethrough, Table, Trash2, Type, Undo2, UploadCloud, type LucideIcon,
} from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { filterCommands, groupCommands, loadRecent, pushRecent, saveRecent, withRecentFirst, type Command } from "./commands";

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, Code, Columns2, Copy, Download, Eye, FileCode2, FilePlus2, FileText, Files, Hash,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard, LayoutTemplate, Link, List, ListChecks, ListOrdered,
  ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine, Quote, Redo2, Replace, Search, Share2, SquareCode,
  Star, Strikethrough, Table, Trash2, Type, Undo2, UploadCloud,
};

interface Level {
  title: string | null;
  items: Command[];
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

export function CommandPalette({ open, onOpenChange, commands, groupOrder, placeholder = "Type a command…" }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [stack, setStack] = useState<Level[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    setLoading(false);
    setRecent(loadRecent());
    setStack([{ title: null, items: commands() }]);
  }, [open, commands]);

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

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const pick = useCallback(
    async (cmd: Command) => {
      if (cmd.children) {
        setLoading(true);
        try {
          const items = await cmd.children();
          setStack((s) => [...s, { title: cmd.title.replace(/…$/, ""), items }]);
          setQuery("");
        } finally {
          setLoading(false);
          inputRef.current?.focus();
        }
        return;
      }
      const next = pushRecent(recent, cmd.id);
      saveRecent(next);
      setRecent(next);
      close();
      // Let the dialog unmount and restore focus before the command moves it again or opens another dialog.
      setTimeout(() => void cmd.run(), 0);
    },
    [recent, close],
  );

  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    setQuery("");
  }, []);

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
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay animate-fade-in" />
        <RadixDialog.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[min(92vw,600px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/20 outline-none animate-fade-in"
          aria-label="Command palette"
          data-testid="command-palette"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
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
          <div ref={listRef} id="command-palette-list" role="listbox" aria-label="Commands" className="scrollbar-thin max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
            {loading ? (
              <div className="px-3 py-6 text-center text-sm text-ink-3">Loading…</div>
            ) : flat.length === 0 ? (
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
                    return (
                      <div
                        key={cmd.id}
                        id={`palette-item-${cmd.id}`}
                        role="option"
                        aria-selected={selected}
                        data-index={i}
                        data-testid={`palette-item-${cmd.id}`}
                        className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink select-none", selected && "bg-surface-3")}
                        onMouseEnter={() => setHighlight(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void pick(cmd)}
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
}

/**
 * Whether a keydown should open the palette. Mod-Shift-P always; Mod-K only with a
 * collapsed selection outside text inputs (Mod-K with a selection still means "Link").
 */
export function isPaletteShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  const key = e.key.toLowerCase();
  if (e.shiftKey && key === "p") return true;
  if (e.shiftKey || key !== "k") return false;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !sel || sel.isCollapsed;
}
