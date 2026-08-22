"use client";
import { navigateTo } from "@/lib/nav";
import { Avatar, Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuTrigger, TooltipProvider, GitHubIcon } from "@/components/ui/primitives";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, BookOpen, CalendarCheck, ChevronDown, DraftingCompass, File, FilePlus2, GitBranch, HardDrive, LayoutTemplate, ListChecks, Loader2, LogOut, PenLine, Scale, Search, FileText, Users } from "lucide-react";
import type { DocumentSummary } from "@/server/documents";
import { api } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { TEMPLATES, type Template, type TemplateIcon } from "@/lib/templates";

import { Logo } from "@/components/editor/header";
import { GitHubPicker } from "@/components/editor/github-dialog";
import { MentionsStrip } from "@/components/dashboard/mentions-strip";

type Doc = Omit<DocumentSummary, "updatedAt" | "createdAt"> & { updatedAt: string; createdAt: string };
type SearchDoc = Doc & { snippet: string | null };

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

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
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-3 text-ink-2 transition group-hover:bg-accent group-hover:text-white">
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

export function Dashboard({ user, documents, githubAvailable }: DashboardProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [openPicker, setOpenPicker] = useState(false);
  const [filter, setFilter] = useState<"all" | "mine" | "shared">("all");
  const [results, setResults] = useState<{ query: string; documents: SearchDoc[] } | null>(null);
  const [searching, setSearching] = useState(false);

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
      return true;
    };
    if (serverResults) return serverResults.filter(matchesFilter);
    const q = trimmed.toLowerCase();
    return documents.filter((d) => matchesFilter(d) && (!q || d.title.toLowerCase().includes(q)));
  }, [documents, serverResults, trimmed, filter, user.id]);

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

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-surface-2">
        <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-6">
            <Link href="/" className="flex items-center gap-2.5">
              <Logo className="h-8 w-8" />
              <span className="text-lg font-semibold text-ink">Markdoc</span>
            </Link>
            <div className="relative mx-auto w-full max-w-xl">
              <Search size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
              <input className="input pl-9 pr-9" placeholder="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="search" />
              {searching && <Loader2 size={16} className="pointer-events-none absolute right-3 top-2.5 animate-spin text-ink-4" data-testid="search-loading" />}
            </div>
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

        <section className="mx-auto max-w-6xl px-6 py-8">
          <MentionsStrip />
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            <div className="group flex items-stretch rounded-2xl border border-line bg-surface shadow-sm transition hover:border-accent hover:shadow-md">
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating !== null}
                className="flex flex-1 items-center gap-4 rounded-l-2xl p-5 text-left"
                data-testid="new-document"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-white">{creating === "blank" ? <Loader2 className="animate-spin" /> : <FilePlus2 size={22} />}</span>
                <span>
                  <span className="block text-[15px] font-semibold text-ink">New document</span>
                  <span className="block text-sm text-ink-3">Start with a blank Markdown page.</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setOpenTemplates(true)}
                disabled={creating !== null}
                className="flex items-center gap-1 rounded-r-2xl border-l border-line px-4 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                aria-label="New document from template"
                title="From template"
                data-testid="new-from-template"
              >
                <LayoutTemplate size={16} />
                <ChevronDown size={14} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setOpenPicker(true)}
              className="group flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition hover:border-accent hover:shadow-md"
              data-testid="open-github"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink text-white">
                <GitHubIcon size={22} />
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-ink">Open from GitHub</span>
                <span className="block text-sm text-ink-3">Edit a Markdown file from a gist or repository.</span>
              </span>
            </button>
          </div>

          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Documents</h2>
            <div className="ml-auto flex rounded-lg border border-line bg-surface p-0.5 text-xs">
              {(["all", "mine", "shared"] as const).map((f) => (
                <button key={f} type="button" className={cn("rounded-md px-2.5 py-1 capitalize", filter === f ? "bg-ink text-white" : "text-ink-3 hover:text-ink")} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "mine" ? "Owned by me" : "Shared with me"}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 && !trimmed && documents.length === 0 ? (
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
              <p className="text-sm font-medium text-ink-2">{pending ? `Searching for "${trimmed}"…` : trimmed ? `No matches for "${trimmed}"` : "No matches"}</p>
              <p className="mt-1 text-sm text-ink-3">{pending ? "Looking through titles and content." : "Try a different search."}</p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="document-list">
              {filtered.map((d) => (
                <li key={d.id} data-testid={trimmed ? "search-result" : undefined}>
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
                    <div className="mt-3 flex items-center gap-2 text-xs text-ink-4">
                      <span>Edited {relativeTime(d.updatedAt)}</span>
                      {d.ownerId !== user.id && (
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} /> {d.ownerName ?? d.ownerLogin} · {d.role}
                        </span>
                      )}
                    </div>
                  </Link>
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

        <Dialog open={openTemplates} onOpenChange={(open) => !creating && setOpenTemplates(open)}>
          <DialogContent title="New from template" description="Pick a starting point. Everything is plain Markdown you can change afterwards." wide>
            <div data-testid="template-dialog">
              <TemplateGrid onPick={(t) => void create(t)} busy={creating} />
            </div>
          </DialogContent>
        </Dialog>
      </main>
    </TooltipProvider>
  );
}




