import type { HeadingInfo } from "@/editor/markdown/parse";
import type { EditMode } from "@/editor/collab/session";
import { SLASH_GROUPS, SLASH_ITEMS, type SlashContext, type SlashItem, type SlashWhere } from "@/editor/slash-items";
import type { Layout } from "./status-bar";
import type { DialogKind } from "./actions";
import type { ExportFormat } from "./header";
import { nextTheme, readThemePreference, setThemePreference, themeLabel } from "@/lib/theme";

/**
 * One entry in the command palette. The registry is a pure function of a plain
 * context object so it can be unit-tested without React or live editors.
 */
export interface Command {
  id: string;
  title: string;
  keywords: string[];
  group: string;
  /** Keymap-style shortcut, e.g. "Mod-Shift-P"; rendered through `shortcut()`. */
  shortcut?: string;
  /** lucide icon name, resolved by the palette. */
  icon?: string;
  /** Hides the item when false. */
  when?: () => boolean;
  run: () => void | Promise<void>;
  /** When set, picking the item shows these children instead of running it. */
  children?: () => Command[] | Promise<Command[]>;
}

export interface DocumentRef {
  id: string;
  title: string;
}

/** The minimal view of a ProseMirror editor the slash items need. */
type RichView = SlashContext["view"];

export interface EditorCommandContext {
  /** Toolbar-style formatting and reveal helpers (EditorActions in the shell). */
  actions: {
    rich: RichView | null;
    toggleMark: (kind: "strong" | "em" | "code" | "strike") => void;
    undo: () => void;
    redo: () => void;
    revealSource: (offset: number, opts?: { focus?: boolean }) => void;
  };
  session: {
    canEdit: boolean;
    canComment: boolean;
    mode: EditMode;
    /** Whether the user's role allows switching to editing or suggesting. */
    canChangeMode: boolean;
    setMode: (mode: EditMode) => void;
  };
  doc: { id: string; title: string; storage: string; githubUrl?: string | null };
  isOwner: boolean;
  slashWhere: SlashWhere;
  setDialog: (kind: DialogKind) => void;
  openLink: () => void;
  openImage: () => void;
  startComment: () => void;
  toggleComments: () => void;
  toggleHistory: () => void;
  toggleActivity: () => void;
  layout: Layout;
  setLayout: (layout: Layout) => void;
  outlineOpen: boolean;
  toggleOutline: () => void;
  syncScroll: boolean;
  setSyncScroll: (on: boolean) => void;
  openFind: (replace: boolean) => void;
  download: (format: ExportFormat) => void;
  copyMarkdown: () => void;
  duplicate: () => void;
  trash: () => void;
  publish: () => void;
  openReader: () => void;
  navigate: (href: string) => void;
  headings: () => HeadingInfo[];
  recentDocuments: () => Promise<DocumentRef[]>;
  /** Optional toast for commands whose effect is not obvious from the UI. */
  notify?: (message: string) => void;
}

export const EDITOR_GROUPS = ["Recent", "Navigation", "Formatting", "Basic", "Lists", "Blocks", "Insert", "Document", "View", "Help"] as const;

/** Shortcuts the keymaps already bind for slash items; shown as chips in the palette. */
const SLASH_SHORTCUTS: Record<string, string> = {
  text: "Mod-Alt-0",
  heading1: "Mod-Alt-1",
  heading2: "Mod-Alt-2",
  heading3: "Mod-Alt-3",
  bullet: "Mod-Shift-8",
  numbered: "Mod-Shift-7",
  task: "Mod-Shift-9",
  quote: "Mod-Shift-.",
  code: "Mod-Alt-C",
  link: "Mod-K",
  comment: "Mod-Alt-M",
};

const SLASH_GROUP_SET = new Set<string>(SLASH_GROUPS);

/** Block items reused from the slash menu (template items and other extensions are skipped). */
function slashCommands(ctx: EditorCommandContext, items: readonly SlashItem[] = SLASH_ITEMS): Command[] {
  return items
    .filter((item) => SLASH_GROUP_SET.has(item.group) && (!item.available || item.available(ctx.slashWhere)))
    .map((item) => ({
      id: `block:${item.id}`,
      title: item.title,
      keywords: [...item.keywords, "insert", "block"],
      group: item.group,
      icon: item.icon,
      shortcut: SLASH_SHORTCUTS[item.id],
      when: () => (item.id === "comment" ? ctx.session.canComment : ctx.session.canEdit),
      run: () => {
        const view = ctx.actions.rich;
        if (!view) return;
        if (item.command) {
          item.command("")(view.state, view.dispatch, view);
          view.focus();
          return;
        }
        item.run({ view, openImage: ctx.openImage, openLink: ctx.openLink, startComment: ctx.startComment, where: ctx.slashWhere }, "");
      },
    }));
}

function headingCommands(ctx: EditorCommandContext): Command[] {
  return ctx.headings().map((h, i) => ({
    id: `heading:${i}`,
    title: h.text || "(untitled heading)",
    keywords: [`h${h.level}`, `line ${h.line}`],
    group: "Headings",
    icon: `Heading${Math.min(h.level, 6)}`,
    run: () => ctx.actions.revealSource(h.from, { focus: true }),
  }));
}

export function documentCommands(docs: DocumentRef[], navigate: (href: string) => void, group = "Recent documents"): Command[] {
  return docs.map((d) => ({
    id: `doc:${d.id}`,
    title: d.title || "Untitled",
    keywords: ["document", "open"],
    group,
    icon: "FileText",
    run: () => navigate(`/d/${d.id}`),
  }));
}

export function buildCommands(ctx: EditorCommandContext): Command[] {
  const canEdit = () => ctx.session.canEdit;
  const canChangeMode = () => ctx.session.canChangeMode;
  const layoutItem = (layout: Layout, title: string, keywords: string[], icon: string): Command => ({
    id: `layout:${layout}`,
    title,
    keywords: ["layout", "view", "pane", ...keywords],
    group: "View",
    icon,
    when: () => ctx.layout !== layout,
    run: () => ctx.setLayout(layout),
  });
  const modeItem = (mode: EditMode, title: string, keywords: string[], icon: string): Command => ({
    id: `mode:${mode}`,
    title,
    keywords: ["mode", ...keywords],
    group: "View",
    icon,
    when: () => canChangeMode() && ctx.session.mode !== mode,
    run: () => ctx.session.setMode(mode),
  });

  const navigation: Command[] = [
    {
      id: "nav:heading",
      title: "Go to heading…",
      keywords: ["jump", "outline", "section", "navigate"],
      group: "Navigation",
      icon: "Hash",
      children: () => headingCommands(ctx),
      run: () => {},
    },
    {
      id: "nav:recent",
      title: "Open recent document…",
      keywords: ["switch", "file", "documents", "recent"],
      group: "Navigation",
      icon: "FileText",
      children: async () => documentCommands(await ctx.recentDocuments(), ctx.navigate),
      run: () => {},
    },
    { id: "nav:dashboard", title: "Go to dashboard", keywords: ["home", "back", "documents", "list"], group: "Navigation", icon: "ArrowLeft", run: () => ctx.navigate("/") },
  ];

  const formatting: Command[] = [
    { id: "format:bold", title: "Bold", keywords: ["strong", "b"], group: "Formatting", icon: "Bold", shortcut: "Mod-B", when: canEdit, run: () => ctx.actions.toggleMark("strong") },
    { id: "format:italic", title: "Italic", keywords: ["em", "emphasis", "i"], group: "Formatting", icon: "Italic", shortcut: "Mod-I", when: canEdit, run: () => ctx.actions.toggleMark("em") },
    { id: "format:strike", title: "Strikethrough", keywords: ["strike", "del"], group: "Formatting", icon: "Strikethrough", shortcut: "Mod-Shift-X", when: canEdit, run: () => ctx.actions.toggleMark("strike") },
    { id: "format:code", title: "Inline code", keywords: ["mono", "monospace", "tt"], group: "Formatting", icon: "Code", shortcut: "Mod-`", when: canEdit, run: () => ctx.actions.toggleMark("code") },
    { id: "format:undo", title: "Undo", keywords: ["revert", "back"], group: "Formatting", icon: "Undo2", shortcut: "Mod-Z", when: canEdit, run: () => ctx.actions.undo() },
    { id: "format:redo", title: "Redo", keywords: ["again", "forward"], group: "Formatting", icon: "Redo2", shortcut: "Mod-Shift-Z", when: canEdit, run: () => ctx.actions.redo() },
  ];

  const document: Command[] = [
    { id: "doc:share", title: "Share", keywords: ["collaborators", "invite", "permissions", "link"], group: "Document", icon: "Share2", run: () => ctx.setDialog("share") },
    {
      id: "doc:publish",
      title: ctx.doc.storage === "gist" ? "Update gist" : ctx.doc.storage === "local" ? "Publish to GitHub…" : "Commit to GitHub…",
      keywords: ["github", "publish", "commit", "push", "gist", "storage"],
      group: "Document",
      icon: "UploadCloud",
      when: canEdit,
      run: () => ctx.publish(),
    },
    { id: "doc:download-md", title: "Download Markdown", keywords: ["export", "save", "md", "file"], group: "Document", icon: "Download", run: () => ctx.download("md") },
    { id: "doc:download-html", title: "Download HTML", keywords: ["export", "save", "web", "file"], group: "Document", icon: "FileCode2", run: () => ctx.download("html") },
    { id: "doc:download-pdf", title: "Download PDF", keywords: ["export", "save", "print", "file"], group: "Document", icon: "FileText", run: () => ctx.download("pdf") },
    { id: "doc:copy-markdown", title: "Copy Markdown", keywords: ["clipboard", "source"], group: "Document", icon: "Copy", run: () => ctx.copyMarkdown() },
    { id: "doc:reader", title: "Open reader view", keywords: ["read", "preview", "publish", "print", "p"], group: "Document", icon: "BookOpen", run: () => ctx.openReader() },
    { id: "doc:duplicate", title: "Make a copy", keywords: ["duplicate", "clone", "copy"], group: "Document", icon: "Files", run: () => ctx.duplicate() },
    { id: "doc:trash", title: "Move to trash", keywords: ["delete", "remove"], group: "Document", icon: "Trash2", when: () => ctx.isOwner, run: () => ctx.trash() },
    { id: "doc:history", title: "Version history", keywords: ["versions", "revisions", "restore"], group: "Document", icon: "History", run: () => ctx.toggleHistory() },
    { id: "doc:name-version", title: "Name this version", keywords: ["save", "snapshot", "tag"], group: "Document", icon: "Pencil", when: canEdit, run: () => ctx.setDialog("versionName") },
    { id: "doc:activity", title: "Activity", keywords: ["log", "changes", "who", "feed"], group: "Document", icon: "Activity", run: () => ctx.toggleActivity() },
    { id: "doc:comments", title: "Comments", keywords: ["discussion", "review", "suggestions", "panel"], group: "Document", icon: "MessageSquare", shortcut: "Mod-Alt-M", run: () => ctx.toggleComments() },
    { id: "doc:find", title: "Find", keywords: ["search", "locate"], group: "Document", icon: "Search", shortcut: "Mod-F", run: () => ctx.openFind(false) },
    { id: "doc:find-replace", title: "Find and replace", keywords: ["search", "substitute", "rename"], group: "Document", icon: "Replace", shortcut: "Mod-H", when: canEdit, run: () => ctx.openFind(true) },
  ];

  const view: Command[] = [
    layoutItem("code", "Layout: Markdown only", ["code", "source", "markdown"], "Code"),
    layoutItem("rich", "Layout: Preview only", ["rich", "preview", "wysiwyg"], "Eye"),
    layoutItem("split", "Layout: Markdown and preview", ["split", "both", "side by side"], "Columns2"),
    {
      id: "view:outline",
      title: ctx.outlineOpen ? "Hide outline" : "Show outline",
      keywords: ["toggle", "outline", "toc", "table of contents", "sidebar"],
      group: "View",
      icon: "ListTree",
      run: () => ctx.toggleOutline(),
    },
    {
      id: "view:sync-scroll",
      title: ctx.syncScroll ? "Turn off synced scrolling" : "Turn on synced scrolling",
      keywords: ["toggle", "sync", "scroll", "scrolling", "panes"],
      group: "View",
      icon: "ArrowDownUp",
      run: () => ctx.setSyncScroll(!ctx.syncScroll),
    },
    {
      id: "view:theme",
      title: "Toggle theme",
      keywords: ["theme", "dark", "light", "system", "appearance", "mode", "color scheme"],
      group: "View",
      icon: "SunMoon",
      run: () => {
        const next = nextTheme(readThemePreference());
        setThemePreference(next);
        ctx.notify?.(`Theme: ${themeLabel(next)}`);
      },
    },
    modeItem("editing", "Mode: Editing", ["edit", "write"], "PenLine"),
    modeItem("suggesting", "Mode: Suggesting", ["suggest", "track changes", "review"], "MessageSquareDashed"),
    modeItem("viewing", "Mode: Viewing", ["view", "read only", "preview"], "Eye"),
  ];

  const help: Command[] = [{ id: "help:shortcuts", title: "Keyboard shortcuts", keywords: ["help", "keys", "hotkeys", "cheatsheet"], group: "Help", icon: "Keyboard", shortcut: "Mod-/", run: () => ctx.setDialog("shortcuts") }];

  return [...navigation, ...formatting, ...slashCommands(ctx), ...document, ...view, ...help];
}

export interface DashboardCommandContext {
  createDocument: (templateId?: string) => void;
  templates: () => Promise<{ id: string; name: string; description?: string }[]>;
  recentDocuments: () => Promise<DocumentRef[]>;
  starredDocuments: () => Promise<DocumentRef[]>;
  showTrash: () => void;
  navigate: (href: string) => void;
  signOut: () => void;
}

export function buildDashboardCommands(ctx: DashboardCommandContext): Command[] {
  return [
    { id: "dash:new", title: "New document", keywords: ["create", "blank", "add"], group: "Create", icon: "FilePlus2", run: () => ctx.createDocument() },
    {
      id: "dash:template",
      title: "New from template…",
      keywords: ["create", "templates", "meeting", "readme", "blog"],
      group: "Create",
      icon: "LayoutTemplate",
      children: async () =>
        (await ctx.templates()).map((t) => ({
          id: `template:${t.id}`,
          title: t.name,
          keywords: t.description ? t.description.toLowerCase().split(/\W+/).filter(Boolean) : [],
          group: "Templates",
          icon: "LayoutTemplate",
          run: () => ctx.createDocument(t.id),
        })),
      run: () => {},
    },
    {
      id: "dash:recent",
      title: "Open recent…",
      keywords: ["documents", "open", "switch", "recent"],
      group: "Navigation",
      icon: "FileText",
      children: async () => documentCommands(await ctx.recentDocuments(), ctx.navigate),
      run: () => {},
    },
    {
      id: "dash:starred",
      title: "Starred…",
      keywords: ["favorites", "favourites", "pinned", "star"],
      group: "Navigation",
      icon: "Star",
      children: async () => documentCommands(await ctx.starredDocuments(), ctx.navigate, "Starred"),
      run: () => {},
    },
    { id: "dash:trash", title: "Trash", keywords: ["deleted", "restore", "bin"], group: "Navigation", icon: "Trash2", run: () => ctx.showTrash() },
    { id: "dash:settings", title: "Settings (API tokens)", keywords: ["agents", "tokens", "api", "preferences", "account"], group: "Account", icon: "Bot", run: () => ctx.navigate("/settings") },
    { id: "dash:signout", title: "Sign out", keywords: ["logout", "log out", "leave"], group: "Account", icon: "LogOut", run: () => ctx.signOut() },
  ];
}

/** Match rank; lower is better. `null` when the command does not match. */
export function matchRank(cmd: Command, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 4;
  const title = cmd.title.toLowerCase();
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  if (title.split(/\s+/).some((w) => w.startsWith(q)) || title.includes(q)) return 2;
  if (cmd.keywords.some((k) => k.toLowerCase().startsWith(q) || k.toLowerCase().includes(q))) return 3;
  // Every word of a multi-word query must prefix-match a title word or a keyword.
  const words = q.split(/\s+/);
  if (words.length > 1) {
    const haystack = [...title.split(/\s+/), ...cmd.keywords.map((k) => k.toLowerCase())];
    if (words.every((w) => haystack.some((h) => h.startsWith(w)))) return 3;
  }
  return null;
}

/** Visible commands (`when` honoured) matching `query`, best rank first; ties keep registry order. */
export function filterCommands(query: string, commands: readonly Command[]): Command[] {
  const ranked: { cmd: Command; rank: number; index: number }[] = [];
  commands.forEach((cmd, index) => {
    if (cmd.when && !cmd.when()) return;
    const rank = matchRank(cmd, query);
    if (rank !== null) ranked.push({ cmd, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.cmd);
}

export const RECENT_STORAGE_KEY = "markdoc:paletteRecent";
export const RECENT_MAX = 5;

/** Most recent first, de-duplicated, capped at `max`. */
export function pushRecent(recent: readonly string[], id: string, max = RECENT_MAX): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

/**
 * Orders commands for an empty query: recently run ones first (most recent first,
 * re-grouped as "Recent"), then the rest in registry order.
 */
export function withRecentFirst(commands: readonly Command[], recent: readonly string[]): Command[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const top: Command[] = [];
  for (const id of recent) {
    const cmd = byId.get(id);
    if (cmd) top.push({ ...cmd, group: "Recent" });
  }
  const topIds = new Set(top.map((c) => c.id));
  return [...top, ...commands.filter((c) => !topIds.has(c.id))];
}

export function loadRecent(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): string[] {
  try {
    const raw = storage?.getItem(RECENT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(recent: readonly string[], storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    storage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)));
  } catch {
    // Storage may be unavailable; recents are a convenience only.
  }
}

/** Groups in display order, preserving each item's relative order. */
export function groupCommands(commands: readonly Command[], order: readonly string[] = EDITOR_GROUPS): { group: string; items: Command[] }[] {
  const rank = new Map(order.map((g, i) => [g, i]));
  const groups = new Map<string, Command[]>();
  for (const c of commands) {
    const list = groups.get(c.group);
    if (list) list.push(c);
    else groups.set(c.group, [c]);
  }
  return [...groups.entries()]
    .map(([group, items]) => ({ group, items }))
    .sort((a, b) => (rank.get(a.group) ?? order.length) - (rank.get(b.group) ?? order.length));
}
