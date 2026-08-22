"use client";
import { navigateTo } from "@/lib/nav";
import { Avatar, Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuTrigger, TooltipProvider, GitHubIcon } from "@/components/ui/primitives";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, FilePlus2, GitBranch, HardDrive, Loader2, LogOut, Search, FileText, Users } from "lucide-react";
import type { DocumentSummary } from "@/server/documents";
import { api } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

import { Logo } from "@/components/editor/header";
import { GitHubPicker } from "@/components/editor/github-dialog";

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
  const [creating, setCreating] = useState(false);
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

  // Server results for the current query win; otherwise filter the loaded list by title/excerpt so
  // typing feels instant while the request is in flight (or for queries too short to send).
  const serverResults = results && trimmed.length >= MIN_QUERY_LENGTH && results.query === trimmed ? results.documents : null;
  const filtered = useMemo<(Doc & { snippet?: string | null })[]>(() => {
    const matchesFilter = (d: Doc) => {
      if (filter === "mine" && d.ownerId !== user.id) return false;
      if (filter === "shared" && d.ownerId === user.id) return false;
      return true;
    };
    if (serverResults) return serverResults.filter(matchesFilter);
    const q = trimmed.toLowerCase();
    return documents.filter((d) => matchesFilter(d) && (!q || d.title.toLowerCase().includes(q) || d.excerpt.toLowerCase().includes(q)));
  }, [documents, serverResults, trimmed, filter, user.id]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await api.documents.create({});
      router.push(`/d/${res.document.id}`);
    } finally {
      setCreating(false);
    }
  };

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
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              className="group flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition hover:border-accent hover:shadow-md"
              data-testid="new-document"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-white">{creating ? <Loader2 className="animate-spin" /> : <FilePlus2 size={22} />}</span>
              <span>
                <span className="block text-[15px] font-semibold text-ink">New document</span>
                <span className="block text-sm text-ink-3">Start with a blank Markdown page.</span>
              </span>
            </button>
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

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
              <FileText className="mx-auto mb-3 text-ink-4" size={28} />
              <p className="text-sm font-medium text-ink-2">{trimmed ? `No matches for "${trimmed}"` : documents.length === 0 ? "No documents yet" : "No matches"}</p>
              <p className="mt-1 text-sm text-ink-3">{!trimmed && documents.length === 0 ? "Create a new document or open one from GitHub." : "Try a different search."}</p>
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
      </main>
    </TooltipProvider>
  );
}




