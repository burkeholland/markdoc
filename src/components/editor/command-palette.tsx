"use client";

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog as RadixDialog } from "radix-ui";
import {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, ChevronLeft, ChevronRight, Code, Columns2, Copy, CornerDownLeft, Download, Eye,
  FileCode2, FilePlus2, FileText, Files, Hash, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard,
  LayoutTemplate, Link, List, ListChecks, ListOrdered, ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine,
  Quote, Redo2, Replace, Search, Share2, SquareCode, SquarePlay, Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users, type LucideIcon,
} from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { focusReturnTarget, restoreFocus } from "@/lib/a11y";
import { apiErrorText } from "@/lib/api";
import { cn, shortcut } from "@/lib/utils";
import { filterCommands, groupCommands, loadRecent, pushRecent, saveRecent, withRecentFirst, type Command } from "./commands";

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, Code, Columns2, Copy, Download, Eye, FileCode2, FilePlus2, FileText, Files, Hash,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard, LayoutTemplate, Link, List, ListChecks, ListOrdered,
  ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine, Quote, Redo2, Replace, Search, Share2, SquareCode, SquarePlay,
  Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users,
};
interface Level {
  title: string | null;
  items: Command[];
}

interface ChildLoad {
  token: symbol;
  command: Command;
  retry: boolean;
}

interface ChildLoadError {
  command: Command;
  message: string;
}

interface PendingRun {
  command: Command;
  commands: () => Command[];
  nested: boolean;
}

/** Resolves the command to run against the live registry, so a stale closure or revoked permission never runs. */
function liveCommand(pending: PendingRun): Command | null {
  const scope = pending.command.executionScope;
  if (scope?.isCurrent?.() === false) return null;
  const current = pending.commands();
  if (scope !== undefined && !current.some((candidate) => candidate.executionScope === scope)) return null;
  if (pending.nested) return pending.command;
  const command = current.find((candidate) => candidate.id === pending.command.id);
  if (!command || command.children || command.executionScope !== scope) return null;
  return command;
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const childTokenRef = useRef<symbol | null>(null);
  const pendingRunRef = useRef<PendingRun | null>(null);
  const runTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(open);
  const [seenOpen, setSeenOpen] = useState(false);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  if (open !== seenOpen) {
    setSeenOpen(open);
    // A menu item that opened the palette unmounts with its menu, so this resolves it to the menu's trigger.
    if (open) setReturnFocus(focusReturnTarget());
  }

  useLayoutEffect(() => {
    openRef.current = open;
    childTokenRef.current = null;
    if (!open) return;
    pendingRunRef.current = null;
    if (runTimerRef.current !== null) clearTimeout(runTimerRef.current);
    runTimerRef.current = null;
    setQuery("");
    setStack([{ title: null, items: commands() }]);
    setHighlight(0);
    setRecent(loadRecent());
    setChildLoad(null);
    setChildError(null);
    // Only an open starts a fresh visit; a new `commands` identity while open is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const seenCommandsRef = useRef(commands);
  useLayoutEffect(() => {
    if (seenCommandsRef.current === commands) return;
    seenCommandsRef.current = commands;
    // A parent re-render can hand over a new registry mid-visit: refresh the root list in place without
    // dropping the user's query or an open child list.
    if (openRef.current) setStack((current) => (current.length ? [{ title: null, items: commands() }, ...current.slice(1)] : current));
  }, [commands]);

  useEffect(
    () => () => {
      childTokenRef.current = null;
      if (runTimerRef.current !== null) clearTimeout(runTimerRef.current);
    },
    [],
  );

  const level = stack[stack.length - 1];
  const atRoot = stack.length <= 1;
  const trimmed = query.trim();
  const visible = useMemo(() => {
    if (!level) return [];
    const matched = filterCommands(query, level.items);
    return !trimmed && atRoot ? withRecentFirst(matched, recent) : matched;
  }, [level, query, trimmed, atRoot, recent]);
  const sections = useMemo(
    () => (trimmed ? [{ group: null as string | null, items: visible }] : groupCommands(visible, groupOrder)),
    [visible, trimmed, groupOrder],
  );
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const retrying = !!childError && childLoad?.retry === true && childLoad.command.id === childError.command.id;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, flat]);

  function cancelChildLoad() {
    childTokenRef.current = null;
    setChildLoad(null);
  }

  function startChildren(command: Command, retry: boolean) {
    const provider = command.children;
    if (!provider) return;
    if (childLoad && childLoad.command === command && childTokenRef.current === childLoad.token) return;
    const token = Symbol("command-palette-child");
    const startQuery = query;
    childTokenRef.current = token;
    setChildLoad({ token, command, retry });
    if (!retry) setChildError(null);
    let pending: Promise<Command[]>;
    try {
      pending = Promise.resolve(provider());
    } catch (error: unknown) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (items) => {
        if (childTokenRef.current !== token) return;
        childTokenRef.current = null;
        setStack((current) => [...current, { title: command.title.replace(/…$/, ""), items }]);
        // Text typed while the list loaded is meant for that list; the query that found the parent is not.
        setQuery((current) => (current === startQuery ? "" : current));
        setHighlight(0);
        setChildLoad(null);
        setChildError(null);
        inputRef.current?.focus();
      },
      (error: unknown) => {
        if (childTokenRef.current !== token) return;
        childTokenRef.current = null;
        const title = command.title.replace(/…$/, "").trim();
        setChildLoad(null);
        setChildError({ command, message: apiErrorText(error, `Could not load ${title || "commands"}`) });
        inputRef.current?.focus();
      },
    );
  }

  function close() {
    cancelChildLoad();
    setChildError(null);
    onOpenChange(false);
  }

  function pick(index: number) {
    const command = flat[index];
    if (!command || pendingRunRef.current || !openRef.current) return;
    if (childLoad?.command.id === command.id || childError?.command.id === command.id) return;
    if (command.children) {
      startChildren(command, false);
      return;
    }
    const nextRecent = pushRecent(recent, command.id);
    saveRecent(nextRecent);
    setRecent(nextRecent);
    pendingRunRef.current = { command, commands, nested: stack.length > 1 };
    close();
  }

  function back() {
    if (atRoot) return;
    cancelChildLoad();
    setChildError(null);
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
    setQuery("");
    setHighlight(0);
    inputRef.current?.focus();
  }

  function moveHighlight(next: number) {
    if (next === highlight) return;
    setHighlight(next);
  }

  let index = -1;
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay animate-fade-in" />
        <RadixDialog.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[min(92vw,600px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/20 outline-none animate-fade-in"
          aria-label="Command palette"
          data-testid="command-palette"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const content = event.currentTarget as HTMLElement;
            if (returnFocus?.isConnected && content.contains(document.activeElement)) {
              returnFocus.focus({ preventScroll: true });
            } else {
              restoreFocus(returnFocus);
            }
            const pending = pendingRunRef.current;
            if (!pending) return;
            runTimerRef.current = setTimeout(() => {
              runTimerRef.current = null;
              if (pendingRunRef.current !== pending) return;
              pendingRunRef.current = null;
              const command = liveCommand(pending);
              if (!command || (command.when && !command.when())) return;
              void command.run();
            }, 0);
          }}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">Search every action, heading and recent document.</RadixDialog.Description>
          <form
            className="flex items-center gap-2 border-b border-line px-3"
            onSubmit={(event) => {
              event.preventDefault();
              pick(highlight);
            }}
          >
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
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={(event) => {
                const { key } = event;
                if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
                const count = flat.length;
                if (key === "Enter") {
                  event.preventDefault();
                  pick(highlight);
                } else if (key === "Backspace" && !query && !atRoot) {
                  event.preventDefault();
                  back();
                } else if (key === "ArrowDown" || key === "ArrowUp") {
                  event.preventDefault();
                  if (count) moveHighlight(key === "ArrowDown" ? (highlight + 1) % count : (highlight - 1 + count) % count);
                } else if (key === "Home" || key === "End") {
                  event.preventDefault();
                  moveHighlight(key === "Home" ? 0 : Math.max(0, count - 1));
                } else if ((key === "PageDown" || key === "PageUp") && count) {
                  event.preventDefault();
                  moveHighlight(key === "PageDown" ? Math.min(highlight + 10, count - 1) : Math.max(highlight - 10, 0));
                }
              }}
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
          </form>
          {childError && (
            <div className="mx-1.5 mt-1.5 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
              <span className="min-w-0 flex-1 wrap-anywhere">{childError.message}</span>
              <button
                type="button"
                className="btn btn-sm btn-outline shrink-0"
                onClick={() => {
                  if (!retrying) startChildren(childError.command, true);
                }}
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
              sections.map((section, sectionIndex) => (
                <div key={section.group ?? `q-${sectionIndex}`} role="group" aria-label={section.group ?? undefined}>
                  {section.group && <div className="menu-label">{section.group}</div>}
                  {section.items.map((command) => {
                    index += 1;
                    const itemIndex = index;
                    const selected = itemIndex === highlight;
                    const unavailable = childLoad?.command.id === command.id || childError?.command.id === command.id;
                    return (
                      <div
                        key={command.id}
                        id={`palette-item-${command.id}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={unavailable || undefined}
                        data-index={itemIndex}
                        data-testid={`palette-item-${command.id}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink select-none",
                          selected && "bg-surface-3",
                          unavailable && "cursor-default opacity-60",
                        )}
                        onMouseEnter={() => moveHighlight(itemIndex)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pick(itemIndex)}
                      >
                        <CommandIcon name={command.icon} />
                        <span className="flex-1 truncate" title={command.title}>{command.title}</span>
                        {command.shortcut && <Kbd>{shortcut(command.shortcut)}</Kbd>}
                        {command.children && <ChevronRight size={14} className="text-ink-4" aria-hidden />}
                        {selected && !command.children && <CornerDownLeft size={13} className="text-ink-4" aria-hidden />}
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
