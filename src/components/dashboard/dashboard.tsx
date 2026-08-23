"use client";
import { navigateTo } from "@/lib/nav";
import { Avatar, Dialog, DialogContent, DialogTrigger, Menu, MenuContent, MenuItem, MenuTrigger, TooltipProvider, GitHubIcon } from "@/components/ui/primitives";
import { ThemeToggle } from "@/components/ui/theme-toggle";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, BookOpen, CalendarCheck, ChevronDown, DraftingCompass, File, FilePlus2, GitBranch, HardDrive, LayoutTemplate, ListChecks, Loader2, LogOut, PenLine, RotateCcw, Scale, Search, FileText, Star, Trash2, Users, X } from "lucide-react";
import { api, type DocumentSummaryDto, type SearchResultDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ui/relative-time";
import { takePendingNotice, type PendingNotice } from "@/lib/notice";
import { TEMPLATES, type Template, type TemplateIcon } from "@/lib/templates";

import { Logo } from "@/components/editor/header";
import { GitHubPicker } from "@/components/editor/github-dialog";
import { NotificationsStrip } from "@/components/dashboard/notifications-strip";
import { CommandPalette, isPaletteShortcut } from "@/components/editor/command-palette";
import { buildDashboardCommands } from "@/components/editor/commands";

type Doc = DocumentSummaryDto;
type SearchDoc = SearchResultDto;

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const STARRED_STRIP_MAX = 6;
const DASHBOARD_GROUPS = ["Recent", "Create", "Navigation", "Account"] as const;

export type DashboardSort = "recent" | "modified" | "title" | "created";
export const SORT_STORAGE_KEY = "markdoc:dashboardSort";
const SORT_OPTIONS: { value: DashboardSort; label: string }[] = [
  { value: "recent", label: "Recently opened" },
  { value: "modified", label: "Last modified" },
  { value: "title", label: "Title A–Z" },
  { value: "created", label: "Created" },
];

function isDashboardSort(v: unknown): v is DashboardSort {
  return SORT_OPTIONS.some((o) => o.value === v);
}

/** Most recently opened first; never-opened documents follow, most recently edited first. */
export function compareDocs(sort: DashboardSort): (a: Doc, b: Doc) => number {
  const byUpdated = (a: Doc, b: Doc) => b.updatedAt.localeCompare(a.updatedAt);
  switch (sort) {
    case "recent":
      return (a, b) => {
        if (a.lastOpenedAt && b.lastOpenedAt) return b.lastOpenedAt.localeCompare(a.lastOpenedAt) || byUpdated(a, b);
        if (a.lastOpenedAt) return -1;
        if (b.lastOpenedAt) return 1;
        return byUpdated(a, b);
      };
    case "modified":
      return byUpdated;
    case "title":
      return (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || byUpdated(a, b);
    case "created":
      return (a, b) => b.createdAt.localeCompare(a.createdAt);
  }
}

/** Wrap each case-insensitive occurrence of `needle` in `text` in a <mark>, without touching HTML. */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  const n = needle.trim();
  if (!n) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const target = n.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(target, from);
    if (idx < 0) break;
    if (idx > from) parts.push(text.slice(from, idx));
    parts.push(
      <mark key={idx} className="rounded-sm bg-accent/20 px-0.5 text-ink">
        {text.slice(idx, idx + n.length)}
      </mark>,
    );
    from = idx + n.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const TEMPLATE_ICONS: Record<TemplateIcon, typeof File> = {
  File,
  Users,
  BookOpen,
  DraftingCompass,
  CalendarCheck,
  PenLine,
  Scale,
  ListChecks,
};

/** Grid of template cards; `busy` is the id currently being created (disables the grid). */
export function TemplateGrid({ onPick, busy, compact }: { onPick: (t: Template) => void; busy: string | null; compact?: boolean }) {
  return (
    <ul className={cn("grid gap-3", compact ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3")} data-testid="template-grid">
      {TEMPLATES.map((t) => {
        const Icon = TEMPLATE_ICONS[t.icon];
        const isBusy = busy === t.id;
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onPick(t)}
              disabled={busy !== null}
              aria-busy={isBusy || undefined}
              className="group flex h-full w-full flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-left transition hover:border-accent hover:shadow-sm focus-visible:border-accent disabled:cursor-default disabled:opacity-60"
              data-testid={`template-${t.id}`}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-3 text-ink-2 transition group-hover:bg-accent group-hover:text-on-accent">
                {isBusy ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
              </span>
              <span className="block text-sm font-semibold text-ink">{t.name}</span>
              <span className="block text-xs leading-4 text-ink-3">{t.description}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface DashboardProps {
  user: { id: string; name: string; login: string | null; image: string | null };
  documents: Doc[];
  githubAvailable: boolean;
}

type Filter = "all" | "mine" | "shared" | "starred" | "trash";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Owned by me" },
  { value: "shared", label: "Shared with me" },
  { value: "starred", label: "Starred" },
  { value: "trash", label: "Trash" },
];

const TRASH_RETENTION_DAYS = 30;

/** Star toggle for a document card; hover-visible unless starred. */
function StarButton({ starred, onToggle, className }: { starred: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={starred}
      aria-label={starred ? "Unstar" : "Star"}
      title={starred ? "Unstar" : "Star"}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-surface-3 focus-visible:opacity-100",
        starred ? "text-amber-500" : "text-ink-4 opacity-0 group-hover:opacity-100 hover:text-ink-2",
        className,
      )}
      data-testid="star-toggle"
      data-starred={starred}
    >
      <Star size={15} fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

function StorageBadge({ doc }: { doc: Doc }) {
  if (doc.storage === "repo") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2" title={`${doc.repoOwner}/${doc.repoName}: ${doc.repoPath}`}>
        <GitBranch size={11} /> {doc.repoOwner}/{doc.repoName}
      </span>
    );
  }
  if (doc.storage === "gist") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
        <GitHubIcon size={11} /> Gist
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-3">
      <HardDrive size={11} /> Markdoc
    </span>
  );
}

export function Dashboard({ user, documents: initialDocuments, githubAvailable }: DashboardProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [openPicker, setOpenPicker] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [results, setResults] = useState<{ query: string; documents: SearchDoc[] } | null>(null);
  const [searching, setSearching] = useState(false);

  // One-shot message from the page we came from (e.g. the editor after "Move to trash").
  const [notice, setNotice] = useState<PendingNotice | null>(null);
  useEffect(() => {
    const pending = takePendingNotice();
    if (!pending) return;
    setNotice(pending);
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, []);

  // The trash is loaded on demand; `initialDocuments` never contains trashed documents.
  const [trash, setTrash] = useState<Doc[] | null>(null);
  const [trashBusy, setTrashBusy] = useState<string | null>(null);
  useEffect(() => {
    if (filter !== "trash") return;
    let cancelled = false;
    api.documents
      .list({ trash: true })
      .then((res) => !cancelled && setTrash(res.documents))
      .catch((err: unknown) => {
        console.error(err);
        if (!cancelled) setTrash([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);
  const restore = useCallback(
    async (doc: Doc) => {
      setTrashBusy(doc.id);
      try {
        await api.documents.restore(doc.id);
        setTrash((t) => t?.filter((d) => d.id !== doc.id) ?? null);
        setNotice({ message: `“${doc.title}” was restored.`, kind: "success" });
        router.refresh();
      } catch (err) {
        console.error(err);
        setNotice({ message: err instanceof Error ? err.message : "Could not restore the document", kind: "error" });
      } finally {
        setTrashBusy(null);
      }
    },
    [router],
  );
  const purge = useCallback(async (doc: Doc) => {
    if (!confirm(`Delete “${doc.title}” forever? This cannot be undone.`)) return;
    setTrashBusy(doc.id);
    try {
      await api.documents.delete(doc.id, { permanent: true });
      setTrash((t) => t?.filter((d) => d.id !== doc.id) ?? null);
    } catch (err) {
      console.error(err);
      setNotice({ message: err instanceof Error ? err.message : "Could not delete the document", kind: "error" });
    } finally {
      setTrashBusy(null);
    }
  }, []);

  // Optimistic stars: the server list is the source of truth until the user clicks.
  const [starOverrides, setStarOverrides] = useState<Record<string, boolean>>({});
  const documents = useMemo(() => initialDocuments.map((d) => (d.id in starOverrides ? { ...d, starred: starOverrides[d.id] } : d)), [initialDocuments, starOverrides]);
  const toggleStar = useCallback(
    (doc: Doc) => {
      const next = !doc.starred;
      setStarOverrides((o) => ({ ...o, [doc.id]: next }));
      (next ? api.documents.star(doc.id) : api.documents.unstar(doc.id)).catch((err: unknown) => {
        console.error(err);
        setStarOverrides((o) => ({ ...o, [doc.id]: !next }));
      });
    },
    [],
  );

  // Sort is remembered per browser. Start with the default so server and client markup match, then read storage.
  const [sort, setSort] = useState<DashboardSort>("recent");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (isDashboardSort(saved)) setSort(saved);
    } catch {
      // storage unavailable: keep the default
    }
  }, []);
  const changeSort = (next: DashboardSort) => {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  const trimmed = query.trim();
  const serverQuery = useDebounced(trimmed.length >= MIN_QUERY_LENGTH ? trimmed : "", SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    if (!serverQuery) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    api.documents
      .search(serverQuery, { signal: controller.signal })
      .then((res) => setResults({ query: res.query, documents: res.documents }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [serverQuery]);

  // Server results for the current query win; otherwise filter the loaded list by title so typing
  // feels instant while the request is in flight (or for queries too short to send).
  const serverResults = results && trimmed.length >= MIN_QUERY_LENGTH && results.query === trimmed ? results.documents : null;
  const pending = trimmed.length >= MIN_QUERY_LENGTH && !serverResults && (searching || serverQuery !== trimmed);
  const filtered = useMemo<(Doc & { snippet?: string | null })[]>(() => {
    const matchesFilter = (d: Doc) => {
      if (filter === "mine" && d.ownerId !== user.id) return false;
      if (filter === "shared" && d.ownerId === user.id) return false;
      if (filter === "starred" && !d.starred) return false;
      return true;
    };
    // Search results keep their relevance order (title matches first); the sort applies to the browsing list.
    if (serverResults) return serverResults.map((d) => (d.id in starOverrides ? { ...d, starred: starOverrides[d.id] } : d)).filter(matchesFilter);
    const q = trimmed.toLowerCase();
    return documents.filter((d) => matchesFilter(d) && (!q || d.title.toLowerCase().includes(q))).sort(compareDocs(sort));
  }, [documents, serverResults, trimmed, filter, sort, user.id, starOverrides]);

  const starred = useMemo(() => documents.filter((d) => d.starred).sort(compareDocs(sort)), [documents, sort]);
  const showStrip = filter === "all" && !trimmed && starred.length > 0;

  const [creating, setCreating] = useState<string | null>(null);
  const [openTemplates, setOpenTemplates] = useState(false);

  const create = useCallback(
    async (template?: Template) => {
      const key = template?.id ?? "blank";
      setCreating(key);
      try {
        const res = await api.documents.create(template ? { template: template.id } : {});
        router.push(`/d/${res.document.id}`);
      } catch (err) {
        console.error(err);
        setCreating(null);
      }
    },
    [router],
  );

  // Command palette (Mod-Shift-P, or Mod-K outside the search box), scoped to dashboard actions.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paletteOpen || !isPaletteShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paletteOpen]);
  const listDocs = useCallback(async (qs: string) => {
    const res = await fetch(`/api/documents${qs}`);
    if (!res.ok) throw new Error(`Could not load documents (${res.status})`);
    const data = (await res.json()) as { documents: { id: string; title: string }[] };
    return data.documents.map((d) => ({ id: d.id, title: d.title }));
  }, []);
  const paletteCommands = useCallback(
    () =>
      buildDashboardCommands({
        createDocument: (templateId) => void create(templateId ? TEMPLATES.find((t) => t.id === templateId) : undefined),
        templates: async () => {
          const res = await fetch("/api/templates");
          if (!res.ok) throw new Error(`Could not load templates (${res.status})`);
          const data = (await res.json()) as { templates: { id: string; name: string; description: string }[] };
          return data.templates;
        },
        recentDocuments: () => listDocs("?limit=8"),
        starredDocuments: () => listDocs("?starred=1"),
        showTrash: () => setFilter("trash"),
        navigate: (href) => router.push(href),
        signOut: () => navigateTo("/api/auth/signout"),
      }),
    [create, listDocs, router],
  );

  return (
    <TooltipProvider>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} groupOrder={DASHBOARD_GROUPS} />
      <main className="min-h-screen bg-surface-2">
        <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
          <div className="safe-x mx-auto flex h-16 max-w-6xl items-center gap-3 sm:gap-4 sm:[--safe-pad:1.5rem]">
            <Link href="/" className="flex items-center gap-2.5">
              <Logo className="h-8 w-8" />
              <span className="hidden text-lg font-semibold text-ink sm:inline">Markdoc</span>
            </Link>
            <div className="relative mx-auto w-full max-w-xl">
              <Search size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
              <input className="input pl-9 pr-9" placeholder="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="search" />
              {searching && <Loader2 size={16} className="pointer-events-none absolute right-3 top-2.5 animate-spin text-ink-4" data-testid="search-loading" />}
            </div>
            <ThemeToggle className="shrink-0" />
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="rounded-full" aria-label="Account">
                  <Avatar name={user.name} src={user.image} size={36} />
                </button>
              </MenuTrigger>
              <MenuContent align="end" className="w-56">
                <div className="px-2.5 py-2">
                  <div className="truncate text-sm font-medium text-ink">{user.name}</div>
                  {user.login && <div className="truncate text-xs text-ink-3">@{user.login}</div>}
                </div>
                <MenuItem icon={<Bot size={15} />} onSelect={() => router.push("/settings")}>
                  Agents &amp; API tokens
                </MenuItem>
                <MenuItem icon={<LogOut size={15} />} onSelect={() => navigateTo("/api/auth/signout")}>
                  Sign out
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>

        <section className="safe-x mx-auto max-w-6xl py-6 sm:py-8 sm:[--safe-pad:1.5rem]">
          <NotificationsStrip />
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            <div className="group flex items-stretch rounded-2xl border border-line bg-surface shadow-sm transition hover:border-accent hover:shadow-md">
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating !== null}
                className="flex flex-1 items-center gap-4 rounded-l-2xl p-5 text-left"
                data-testid="new-document"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-on-accent">{creating === "blank" ? <Loader2 className="animate-spin" /> : <FilePlus2 size={22} />}</span>
                <span>
                  <span className="block text-[15px] font-semibold text-ink">New document</span>
                  <span className="block text-sm text-ink-3">Start with a blank Markdown page.</span>
                </span>
              </button>
              <Dialog open={openTemplates} onOpenChange={(open) => !creating && setOpenTemplates(open)}>
                <DialogTrigger asChild>
                  <button
                    type="button"
                    disabled={creating !== null}
                    className="flex items-center gap-1 rounded-r-2xl border-l border-line px-4 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                    aria-label="New document from template"
                    title="From template"
                    data-testid="new-from-template"
                  >
                    <LayoutTemplate size={16} />
                    <ChevronDown size={14} />
                  </button>
                </DialogTrigger>
                <DialogContent title="New from template" description="Pick a starting point. Everything is plain Markdown you can change afterwards." wide>
                  <div data-testid="template-dialog">
                    <TemplateGrid onPick={(t) => void create(t)} busy={creating} />
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <button
              type="button"
              onClick={() => setOpenPicker(true)}
              className="group flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition hover:border-accent hover:shadow-md"
              data-testid="open-github"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-inverse text-white">
                <GitHubIcon size={22} />
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-ink">Open from GitHub</span>
                <span className="block text-sm text-ink-3">Edit a Markdown file from a gist or repository.</span>
              </span>
            </button>
          </div>

          {showStrip && (
            <div className="mb-6" data-testid="starred-strip">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <Star size={14} className="text-amber-500" fill="currentColor" /> Starred
                </h2>
                {starred.length > STARRED_STRIP_MAX && (
                  <button type="button" className="ml-auto text-xs font-medium text-accent hover:underline" onClick={() => setFilter("starred")} data-testid="show-all-starred">
                    Show all starred ({starred.length})
                  </button>
                )}
              </div>
              <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {starred.slice(0, STARRED_STRIP_MAX).map((d) => (
                  <li key={d.id} className="group relative">
                    <Link
                      href={`/d/${d.id}`}
                      className="flex h-full flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2.5 pr-9 shadow-sm transition hover:border-accent hover:shadow-md"
                      data-testid="starred-card"
                    >
                      <span className="line-clamp-2 text-[13px] font-semibold leading-4 text-ink">{d.title}</span>
                      <span className="text-[11px] text-ink-4">{d.lastOpenedAt ? <RelativeTime date={d.lastOpenedAt} prefix="Opened " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                    </Link>
                    <StarButton starred={d.starred} onToggle={() => toggleStar(d)} className="absolute right-1.5 top-1.5" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Documents</h2>
            <div className="ml-auto flex max-w-full items-center gap-2 overflow-x-auto" data-testid="dashboard-chips">
              <label className="flex items-center gap-1.5 text-xs text-ink-3">
                <span className="sr-only">Sort by</span>
                <select
                  className="h-7 rounded-lg border border-line bg-surface px-2 text-xs text-ink-2 outline-none focus-visible:border-accent"
                  value={sort}
                  onChange={(e) => changeSort(e.target.value as DashboardSort)}
                  aria-label="Sort by"
                  data-testid="sort-select"
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex shrink-0 rounded-lg border border-line bg-surface p-0.5 text-xs">
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className={cn("rounded-md px-2.5 py-1", filter === f.value ? "bg-inverse text-white" : "text-ink-3 hover:text-ink")}
                    onClick={() => setFilter(f.value)}
                    aria-pressed={filter === f.value}
                    data-testid={`filter-${f.value}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filter === "trash" ? (
            <TrashView documents={trash} busy={trashBusy} onRestore={restore} onPurge={purge} />
          ) : filtered.length === 0 && !trimmed && documents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-8" data-testid="empty-state">
              <div className="mb-5 text-center">
                <FileText className="mx-auto mb-3 text-ink-4" size={28} />
                <p className="text-sm font-medium text-ink-2">No documents yet</p>
                <p className="mt-1 text-sm text-ink-3">Start from a template, or open a Markdown file from GitHub.</p>
              </div>
              <TemplateGrid compact onPick={(t) => void create(t)} busy={creating} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
              <FileText className="mx-auto mb-3 text-ink-4" size={28} />
              <p className="text-sm font-medium text-ink-2">
                {pending ? `Searching for "${trimmed}"…` : trimmed ? `No matches for "${trimmed}"` : filter === "starred" ? "No starred documents" : "No matches"}
              </p>
              <p className="mt-1 text-sm text-ink-3">
                {pending ? "Looking through titles and content." : filter === "starred" && !trimmed ? "Hover a document and click the star to keep it close." : "Try a different search."}
              </p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="document-list">
              {filtered.map((d) => (
                <li key={d.id} className="group relative" data-testid={trimmed ? "search-result" : undefined}>
                  <Link
                    href={`/d/${d.id}`}
                    className="flex h-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md"
                    data-testid="document-card"
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <h3 className="line-clamp-2 text-[15px] font-semibold leading-5 text-ink">
                        <Highlight text={d.title} needle={trimmed} />
                      </h3>
                      <StorageBadge doc={d} />
                    </div>
                    {d.snippet ? (
                      <p className="line-clamp-3 flex-1 text-[13px] leading-5 text-ink-2" data-testid="search-snippet">
                        <Highlight text={d.snippet} needle={trimmed} />
                      </p>
                    ) : (
                      <p className="line-clamp-3 flex-1 text-[13px] leading-5 text-ink-3">{d.excerpt || "Empty document"}</p>
                    )}
                    <div className="mt-3 flex items-center gap-2 pr-8 text-xs text-ink-4">
                      <span>{sort === "recent" && d.lastOpenedAt ? <RelativeTime date={d.lastOpenedAt} prefix="Opened " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                      {d.ownerId !== user.id && (
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} /> {d.ownerName ?? d.ownerLogin} · {d.role}
                        </span>
                      )}
                    </div>
                  </Link>
                  <StarButton starred={d.starred} onToggle={() => toggleStar(d)} className="absolute bottom-3 right-3" />
                </li>
              ))}
            </ul>
          )}
        </section>

        <Dialog open={openPicker} onOpenChange={setOpenPicker}>
          <DialogContent title="Open from GitHub" description="Pick a Markdown file. Markdoc keeps a live copy and publishes back when you ask it to." wide>
            <GitHubPicker mode="import" githubAvailable={githubAvailable} onImported={(id) => router.push(`/d/${id}`)} />
          </DialogContent>
        </Dialog>

        {notice && (
          <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-white shadow-xl animate-fade-in",
                notice.kind === "error" ? "bg-red-600" : "bg-inverse",
              )}
              role="status"
              data-testid="toast"
              data-kind={notice.kind}
            >
              <span>{notice.message}</span>
              <button type="button" className="text-white/60 hover:text-white" onClick={() => setNotice(null)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          </div>
        )}
      </main>
    </TooltipProvider>
  );
}

/** The caller's trashed documents: not openable; restore or delete forever. `documents` is null while loading. */
function TrashView({ documents, busy, onRestore, onPurge }: { documents: Doc[] | null; busy: string | null; onRestore: (d: Doc) => void; onPurge: (d: Doc) => void }) {
  return (
    <div data-testid="trash-view">
      <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-3" data-testid="trash-note">
        <Trash2 size={12} /> Items are deleted forever after {TRASH_RETENTION_DAYS} days.
      </p>
      {documents === null ? (
        <div className="flex items-center gap-2 py-10 text-sm text-ink-3">
          <Loader2 size={16} className="animate-spin" /> Loading trash…
        </div>
      ) : documents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
          <Trash2 className="mx-auto mb-3 text-ink-4" size={28} />
          <p className="text-sm font-medium text-ink-2">The trash is empty</p>
          <p className="mt-1 text-sm text-ink-3">Documents you move to the trash can be restored here for {TRASH_RETENTION_DAYS} days.</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="trash-list">
          {documents.map((d) => {
            const isBusy = busy === d.id;
            return (
              <li key={d.id} className="flex h-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm" data-testid="trash-card" aria-busy={isBusy || undefined}>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-[15px] font-semibold leading-5 text-ink">{d.title}</h3>
                  <StorageBadge doc={d} />
                </div>
                <p className="line-clamp-3 flex-1 text-[13px] leading-5 text-ink-3">{d.excerpt || "Empty document"}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-4">
                  <span className="whitespace-nowrap">{d.deletedAt ? <RelativeTime date={d.deletedAt} prefix="Trashed " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button type="button" className="btn btn-sm btn-outline gap-1 whitespace-nowrap" disabled={busy !== null} onClick={() => onRestore(d)} data-testid="restore-button">
                      {isBusy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                    </button>
                    <button type="button" className="btn btn-sm gap-1 whitespace-nowrap text-danger hover:bg-red-50 dark:hover:bg-red-950/40" disabled={busy !== null} onClick={() => onPurge(d)} data-testid="purge-button">
                      <Trash2 size={13} /> Delete forever
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}



