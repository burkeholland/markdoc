import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { insertHorizontalRule, insertTable, insertText, setHeadingLevel, toggleBlockquote, toggleCodeBlock, toggleList } from "./prosemirror/commands";

/**
 * Everything a slash item may need from its host. The rich pane supplies the
 * ProseMirror view; the shell supplies the dialog and comment plumbing that
 * lives outside the editor.
 */
export interface SlashContext {
  view: EditorView;
  openImage: () => void;
  openLink: () => void;
  /** Starts a comment on the current selection (see EditorShell.startComment). */
  startComment: () => void;
  /** Opens the "Connect an AI agent" dialog. */
  connectAgent: () => void;
  /** Insertion targets the caret is in; used to hide items that do not fit. */
  where: SlashWhere;
}

export interface SlashWhere {
  inTable: boolean;
  canComment: boolean;
}

export type SlashGroup = "Basic" | "Lists" | "Blocks" | "Insert";

export const SLASH_GROUPS: readonly SlashGroup[] = ["Basic", "Lists", "Blocks", "Insert"];

interface SlashItemBase {
  id: string;
  title: string;
  /** One line under the title, for items whose title alone does not say what happens. */
  description?: string;
  keywords: string[];
  /** lucide icon name, resolved to a component by the menu. */
  icon: string;
  group: SlashGroup;
  /** When set, the item accepts a trailing argument (`/code ts`). */
  acceptsArg?: boolean;
  /** Optional hint shown when an argument is accepted. */
  hint?: string;
  /** Hides the item in contexts where it cannot be inserted. */
  available?: (where: SlashWhere) => boolean;
}

/**
 * An item either edits the document through a ProseMirror `command`, which the
 * menu runs in the same transaction that removes the `/query` (so the choice
 * is one undo step, see `applySlashCommand`), or hands off to the shell with
 * `run` (dialogs, comments) after the `/query` has been removed.
 */
export type SlashItem = SlashItemBase &
  ({ command: (arg: string) => Command; run?: undefined } | { run: (ctx: SlashContext, arg: string) => void; command?: undefined });

const notInTable = (w: SlashWhere) => !w.inTable;

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: "text", title: "Text", keywords: ["paragraph", "plain", "p"], icon: "Type", group: "Basic", command: () => setHeadingLevel(0) },
  { id: "heading1", title: "Heading 1", keywords: ["h1", "title"], icon: "Heading1", group: "Basic", available: notInTable, command: () => setHeadingLevel(1) },
  { id: "heading2", title: "Heading 2", keywords: ["h2", "subtitle"], icon: "Heading2", group: "Basic", available: notInTable, command: () => setHeadingLevel(2) },
  { id: "heading3", title: "Heading 3", keywords: ["h3"], icon: "Heading3", group: "Basic", available: notInTable, command: () => setHeadingLevel(3) },
  { id: "bullet", title: "Bullet list", keywords: ["unordered", "ul", "list"], icon: "List", group: "Lists", available: notInTable, command: () => toggleList("bullet") },
  { id: "numbered", title: "Numbered list", keywords: ["ordered", "ol", "list"], icon: "ListOrdered", group: "Lists", available: notInTable, command: () => toggleList("ordered") },
  { id: "task", title: "Task list", keywords: ["todo", "check", "checkbox", "checklist", "list"], icon: "ListChecks", group: "Lists", available: notInTable, command: () => toggleList("task") },
  { id: "quote", title: "Quote", keywords: ["blockquote", "citation"], icon: "Quote", group: "Blocks", available: notInTable, command: () => toggleBlockquote() },
  {
    id: "code",
    title: "Code block",
    keywords: ["fence", "pre", "snippet"],
    icon: "SquareCode",
    group: "Blocks",
    acceptsArg: true,
    hint: "language",
    available: notInTable,
    command: (arg) => toggleCodeBlock(arg.trim() || null),
  },
  { id: "divider", title: "Divider", keywords: ["hr", "rule", "separator", "line"], icon: "Minus", group: "Blocks", available: notInTable, command: () => insertHorizontalRule() },
  { id: "table", title: "Table", keywords: ["grid", "rows", "columns"], icon: "Table", group: "Blocks", available: notInTable, command: () => insertTable(3, 3) },
  { id: "image", title: "Image", keywords: ["picture", "photo", "img", "upload"], icon: "Image", group: "Insert", run: (ctx) => ctx.openImage() },
  { id: "link", title: "Link", keywords: ["url", "href", "anchor"], icon: "Link", group: "Insert", run: (ctx) => ctx.openLink() },
  {
    id: "comment",
    title: "Comment",
    // `agent`, `ask`, `copilot`, `ai`: mentioning an agent in a comment is how you ask one for work (#1075).
    keywords: ["note", "review", "annotate", "agent", "ask", "copilot", "ai"],
    icon: "MessageSquarePlus",
    group: "Insert",
    available: (w) => w.canComment,
    run: (ctx) => ctx.startComment(),
  },
  { id: "date", title: "Date", keywords: ["today", "now", "time"], icon: "Calendar", group: "Insert", command: () => insertText(todayIso()) },
  {
    id: "agent",
    title: "Connect an AI agent",
    description: "Set up Copilot, Claude or Cursor, or invite your agent here",
    keywords: ["copilot", "claude", "cursor", "bot", "mcp", "ai", "connect", "setup", "keep", "watch"],
    icon: "Bot",
    group: "Insert",
    run: (ctx) => ctx.connectAgent(),
  },
];

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Splits a raw query into the word used for matching and the argument passed to the item. */
export function splitSlashQuery(query: string): { word: string; arg: string } {
  const trimmed = query.trimStart();
  const space = trimmed.indexOf(" ");
  if (space < 0) return { word: trimmed.toLowerCase(), arg: "" };
  return { word: trimmed.slice(0, space).toLowerCase(), arg: trimmed.slice(space + 1).trim() };
}

function matches(item: SlashItem, word: string): boolean {
  if (!word) return true;
  const title = item.title.toLowerCase();
  if (title.startsWith(word)) return true;
  if (title.split(/\s+/).some((part) => part.startsWith(word))) return true;
  return item.keywords.some((k) => k.toLowerCase().startsWith(word));
}

/**
 * Items matching `query`, in group order. Matching is a case-insensitive
 * prefix on the title, any word of the title, or a keyword; an empty query
 * returns everything. When the query carries an argument (`code ts`) only
 * items that accept one are returned.
 */
export function filterSlashItems(query: string, items: readonly SlashItem[] = SLASH_ITEMS, where?: SlashWhere): SlashItem[] {
  const { word, arg } = splitSlashQuery(query);
  const hasArg = arg.length > 0 || /\s$/.test(query.trimStart()) && word.length > 0;
  const order = new Map(SLASH_GROUPS.map((g, i) => [g, i]));
  return items
    .filter((item) => (!where || !item.available || item.available(where)) && (!hasArg || item.acceptsArg) && matches(item, word))
    .sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0));
}
