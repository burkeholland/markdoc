import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { EditorView as SourceView } from "@codemirror/view";
import { insertHorizontalRule, insertTable, insertText, setHeadingLevel, toggleBlockquote, toggleCodeBlock, toggleList } from "./prosemirror/commands";
import { insertFootnote, insertTableOfContents } from "./prosemirror/slash-commands";
import { LOREM_IPSUM, calloutKind } from "./slash-blocks";
// Type only: the source commands reach the menu at run time through `CodeApi.slash`, so CodeMirror stays in its lazy chunk.
import type * as SourceSlash from "./codemirror/slash-commands";

export type SourceSlashCommands = typeof SourceSlash;

/**
 * Everything a slash item may need from its host. The rich pane supplies the
 * ProseMirror view; the shell supplies the dialog and comment plumbing that
 * lives outside the editor.
 */
export interface SlashContext {
  /** The rich editor; null when the item was picked in the source editor. */
  view: EditorView | null;
  openImage: () => void;
  /** Opens "Video or post from a link" (#2317). */
  openCard: () => void;
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
  /** The caret is in the Markdown source editor; items without a `source` command are hidden there. */
  source?: boolean;
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
  /** The same edit in the source editor, as Markdown text. Items with `run` work in both editors. */
  source?: (cm: SourceSlashCommands, arg: string) => (view: SourceView) => boolean;
}

/**
 * An item either edits the document through a ProseMirror `command`, which the
 * menu runs in the same transaction that removes the `/query` (so the choice
 * is one undo step, see `applySlashCommand`), or hands off to the shell with
 * `run` (dialogs, comments) after the `/query` has been removed.
 */
export type SlashItem = SlashItemBase &
  (
    | { command: (arg: string) => Command; run?: undefined }
    | { run: (ctx: SlashContext, arg: string) => void; command?: undefined }
    // Source-only items (see `source`).
    | { source: NonNullable<SlashItemBase["source"]>; command?: undefined; run?: undefined }
  );

const notInTable = (w: SlashWhere) => !w.inTable;

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: "text", title: "Text", keywords: ["paragraph", "plain", "p"], icon: "Type", group: "Basic", command: () => setHeadingLevel(0), source: (cm) => cm.heading(0) },
  { id: "heading1", title: "Heading 1", keywords: ["h1", "title"], icon: "Heading1", group: "Basic", available: notInTable, command: () => setHeadingLevel(1), source: (cm) => cm.heading(1) },
  { id: "heading2", title: "Heading 2", keywords: ["h2", "subtitle"], icon: "Heading2", group: "Basic", available: notInTable, command: () => setHeadingLevel(2), source: (cm) => cm.heading(2) },
  { id: "heading3", title: "Heading 3", keywords: ["h3"], icon: "Heading3", group: "Basic", available: notInTable, command: () => setHeadingLevel(3), source: (cm) => cm.heading(3) },
  { id: "bullet", title: "Bullet list", keywords: ["unordered", "ul", "list"], icon: "List", group: "Lists", available: notInTable, command: () => toggleList("bullet"), source: (cm) => cm.linePrefix("bullet") },
  { id: "numbered", title: "Numbered list", keywords: ["ordered", "ol", "list"], icon: "ListOrdered", group: "Lists", available: notInTable, command: () => toggleList("ordered"), source: (cm) => cm.linePrefix("ordered") },
  { id: "task", title: "Task list", keywords: ["todo", "check", "checkbox", "checklist", "list"], icon: "ListChecks", group: "Lists", available: notInTable, command: () => toggleList("task"), source: (cm) => cm.linePrefix("task") },
  { id: "quote", title: "Quote", keywords: ["blockquote", "citation"], icon: "Quote", group: "Blocks", available: notInTable, command: () => toggleBlockquote(), source: (cm) => cm.linePrefix("quote") },
  {
    // GitHub alerts (fancygist's `/alerts`). Source only: the rich editor shows `[!NOTE]` as text and would escape it.
    id: "callout",
    title: "Callout",
    description: "Note, tip, important, warning or caution",
    keywords: ["alert", "alerts", "admonition", "note", "tip", "important", "warning", "caution"],
    icon: "Info",
    group: "Blocks",
    acceptsArg: true,
    hint: "kind",
    available: (w) => !!w.source && !w.inTable,
    source: (cm, arg) => cm.callout(calloutKind(arg)),
  },
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
    source: (cm, arg) => cm.codeBlock(arg.trim()),
  },
  { id: "divider", title: "Divider", keywords: ["hr", "rule", "separator", "line"], icon: "Minus", group: "Blocks", available: notInTable, command: () => insertHorizontalRule(), source: (cm) => cm.divider },
  { id: "table", title: "Table", keywords: ["grid", "rows", "columns"], icon: "Table", group: "Blocks", available: notInTable, command: () => insertTable(3, 3), source: (cm) => cm.table },
  {
    id: "toc",
    title: "Table of contents",
    description: "Links to every heading in the document",
    keywords: ["toc", "contents", "outline", "index"],
    icon: "ListTree",
    group: "Blocks",
    available: notInTable,
    command: () => insertTableOfContents,
    source: (cm) => cm.tableOfContents,
  },
  { id: "image", title: "Image", keywords: ["picture", "photo", "img", "upload"], icon: "Image", group: "Insert", run: (ctx) => ctx.openImage() },
  { id: "link", title: "Link", keywords: ["url", "href", "anchor"], icon: "Link", group: "Insert", run: (ctx) => ctx.openLink() },
  {
    // After Link, so "/link" still offers Link first. A card is a block of its own at the top level of the document
    // (#2317), so it is not offered in a table.
    id: "card",
    title: "Video or post from a link",
    description: "Paste a link and it becomes a card",
    keywords: ["youtube", "tweet", "twitter", "x", "embed", "card", "media", "player", "clip"],
    icon: "SquarePlay",
    group: "Insert",
    available: notInTable,
    run: (ctx) => ctx.openCard(),
  },
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
  { id: "date", title: "Date", keywords: ["today", "now", "time"], icon: "Calendar", group: "Insert", command: () => insertText(todayIso()), source: (cm) => cm.text(todayIso()) },
  { id: "footnote", title: "Footnote", keywords: ["reference", "citation", "note", "fn"], icon: "Superscript", group: "Insert", available: notInTable, command: () => insertFootnote, source: (cm) => cm.footnote },
  { id: "lorem", title: "Placeholder text", keywords: ["lorem", "ipsum", "dummy", "dummytext", "filler"], icon: "TextQuote", group: "Insert", command: () => insertText(LOREM_IPSUM), source: (cm) => cm.text(LOREM_IPSUM) },
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
    .filter((item) => (!where || !item.available || item.available(where)) && (!where?.source || !item.command || item.source) && (!hasArg || item.acceptsArg) && matches(item, word))
    .sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0));
}
