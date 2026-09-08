"use client";
import { Avatar, Dialog, DialogContent, DialogTrigger, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, TooltipProvider } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";
import { ThemeToggle } from "@/components/ui/theme-toggle";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, BookOpen, CalendarCheck, ChevronDown, DraftingCompass, File, FilePlus2, FolderOpen, GitBranch, LayoutTemplate, ListChecks, Loader2, LogOut, PenLine, RotateCcw, Scale, Search, FileText, Sparkles, Star, Trash2, Users, X } from "lucide-react";
import { api, apiErrorText, type DocumentSummaryDto, type SearchResultDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ui/relative-time";
import { takePendingNotice, type PendingNotice } from "@/lib/notice";
import { PICKER_TEMPLATES, TEMPLATES, WELCOME_TEMPLATE_ID, getTemplate, type Template, type TemplateIcon } from "@/lib/templates";
import { DEFAULT_DASHBOARD_SORT, SORT_COOKIE, SORT_COOKIE_MAX_AGE, SORT_OPTIONS, SORT_STORAGE_KEY, isDashboardSort, type DashboardSort } from "@/lib/dashboard-sort";

import { Logo } from "@/components/ui/logo";
import { GitHubPicker } from "@/components/editor/github-dialog";
import { GITHUB_NOT_CONFIGURED } from "@/components/editor/labels";
import { NotificationsStrip } from "@/components/dashboard/notifications-strip";
import { ImportDialog, ImportDropzone, useFileImport } from "@/components/dashboard/import-dialog";
import { CommandPalette, isPaletteShortcut } from "@/components/editor/command-palette";
import { buildDashboardCommands } from "@/components/editor/commands";
import { signOutSafely } from "@/lib/sign-out";

type Doc = DocumentSummaryDto;
type SearchDoc = SearchResultDto;

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const STARRED_STRIP_MAX = 6;
const DASHBOARD_GROUPS = ["Recent", "Create", "Navigation", "Account"] as const;
const SEARCH_SHORTCUT_BLOCKED = 'input, textarea, select, dialog, [role="dialog"], [data-testid="command-palette"], [contenteditable]:not([contenteditable="false"])';

function isSearchShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  return !(event.target instanceof Element && event.target.closest(SEARCH_SHORTCUT_BLOCKED));
}

function readSortCookie(): string | null {
  const prefix = `${SORT_COOKIE}=`;
  const part = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}

function writeSortCookie(sort: DashboardSort) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SORT_COOKIE}=${sort}; Path=/; Max-Age=${SORT_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
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

const TEMPLATE_ICONS: Record<TemplateIcon, typeof File> = {
  File,
  Users,
  BookOpen,
  DraftingCompass,
  CalendarCheck,
  PenLine,
  Scale,
  ListChecks,
  Sparkles,
};

interface TemplateGridEntryPublication {
  index: number;
  template: Template;
  id: string;
  name: string;
  description: string;
  icon: TemplateIcon;
}

interface TemplateGridRenderPublication {
  onPick: (template: Template) => void;
  busy: string | null;
  compact: boolean | undefined;
  entries: TemplateGridEntryPublication[];
}

interface TemplateGridDomPublication {
  entry: TemplateGridEntryPublication;
  card: HTMLLIElement | null;
  button: HTMLButtonElement | null;
}

interface TemplateGridPublication {
  render: TemplateGridRenderPublication;
  grid: HTMLUListElement;
  entries: TemplateGridDomPublication[];
}

function currentTemplateGridPublication(
  current: TemplateGridPublication | null,
  claimed: TemplateGridPublication | null,
  render: TemplateGridRenderPublication,
  entry: TemplateGridEntryPublication,
  source: HTMLButtonElement,
): TemplateGridPublication | null {
  if (!current || current.render !== render || claimed === current || render.busy !== null) return null;
  const sourceEntry = current.entries[entry.index];
  if (sourceEntry?.entry !== entry || sourceEntry.button !== source || current.entries.length !== PICKER_TEMPLATES.length) return null;

  const grid = current.grid;
  if (!grid.isConnected || grid.children.length !== current.entries.length) return null;
  for (const published of current.entries) {
    const { card, button } = published;
    const rendered = published.entry;
    if (
      PICKER_TEMPLATES[rendered.index] !== rendered.template ||
      rendered.template.id !== rendered.id ||
      rendered.template.name !== rendered.name ||
      rendered.template.description !== rendered.description ||
      rendered.template.icon !== rendered.icon ||
      !card?.isConnected ||
      !button?.isConnected ||
      grid.children.item(rendered.index) !== card ||
      card.parentElement !== grid ||
      card.firstElementChild !== button ||
      card.children.length !== 1 ||
      button.parentElement !== card
    ) {
      return null;
    }
  }
  return current;
}

/** Grid of template cards; `busy` is the id currently being created (disables the grid). */
export function TemplateGrid({ onPick, busy, compact }: { onPick: (t: Template) => void; busy: string | null; compact?: boolean }) {
  const activePublication = useRef<TemplateGridPublication | null>(null);
  const claimedPublication = useRef<TemplateGridPublication | null>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const publication: TemplateGridRenderPublication = {
    onPick,
    busy,
    compact,
    entries: PICKER_TEMPLATES.map((template, index) => ({
      index,
      template,
      id: template.id,
      name: template.name,
      description: template.description,
      icon: template.icon,
    })),
  };

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const committed: TemplateGridPublication = {
      render: publication,
      grid,
      entries: publication.entries.map((entry, index) => {
        const card = grid.children.item(index);
        const button = card?.firstElementChild;
        return {
          entry,
          card: card instanceof HTMLLIElement ? card : null,
          button: button instanceof HTMLButtonElement ? button : null,
        };
      }),
    };
    activePublication.current = committed;
    return () => {
      if (activePublication.current === committed) activePublication.current = null;
    };
  });

  return (
    <ul
      ref={gridRef}
      className={cn("grid gap-3", publication.compact ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3")}
      data-testid="template-grid"
    >
      {publication.entries.map((entry) => {
        const Icon = TEMPLATE_ICONS[entry.icon];
        const isBusy = publication.busy === entry.id;
        return (
          <li key={entry.id} className="min-w-0">
            <button
              type="button"
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                const committed = currentTemplateGridPublication(
                  activePublication.current,
                  claimedPublication.current,
                  publication,
                  entry,
                  event.currentTarget,
                );
                if (!committed) return;
                claimedPublication.current = committed;
                publication.onPick(entry.template);
              }}
              disabled={publication.busy !== null}
              aria-busy={isBusy || undefined}
              className="group flex h-full w-full flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-left transition hover:border-accent hover:shadow-sm focus-visible:border-accent disabled:cursor-default disabled:opacity-60"
              data-testid={`template-${entry.id}`}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-3 text-ink-2 transition group-hover:bg-accent group-hover:text-on-accent">
                {isBusy ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
              </span>
              <span className="block text-sm font-semibold text-ink">{entry.name}</span>
              <span className="block text-xs leading-4 text-ink-3">{entry.description}</span>
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
  /** The server has a GitHub OAuth app; without it the "Open from GitHub" card is disabled and says why (#162). */
  githubConfigured: boolean;
  /** Sort read from the `markdoc.dashboardSort` cookie by the server, so the first paint is already in the saved order (#165). */
  initialSort?: DashboardSort;
}

type Filter = "all" | "mine" | "shared" | "starred" | "trash";
type TrashActionKind = "restore" | "purge";

interface TrashActionOperation {
  visit: number;
  documentId: string;
  kind: TrashActionKind;
  document: Doc;
}

interface CreateOperation {
  ownerId: string;
  key: string;
}

interface SearchAuthority {
  mount: symbol;
  visit: symbol;
  user: DashboardProps["user"];
  userId: string;
}

interface SearchShortcutOwner {
  active: boolean;
  readonly authority: SearchAuthority;
  readonly user: DashboardProps["user"];
  readonly target: Window;
  readonly input: HTMLInputElement;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}

interface PaletteShortcutOwner {
  active: boolean;
  open: boolean;
  readonly authority: SearchAuthority;
  readonly user: DashboardProps["user"];
  readonly target: Window;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}

interface SearchDebounceOwner {
  authority: SearchAuthority;
  query: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface SearchRequestOwner {
  authority: SearchAuthority;
  query: string;
  controller: AbortController;
}

interface SearchResults {
  authority: SearchAuthority;
  query: string;
  documents: SearchDoc[];
}

interface SearchError {
  authority: SearchAuthority;
  query: string;
  message: string;
}

interface NoticeAuthority {
  mount: symbol;
  userId: string;
}

interface NoticePublication {
  authority: NoticeAuthority;
  notice: PendingNotice;
  timer: ReturnType<typeof setTimeout> | null;
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Owned by me" },
  { value: "shared", label: "Shared with me" },
  { value: "starred", label: "Starred" },
  { value: "trash", label: "Trash" },
];

const TRASH_RETENTION_DAYS = 30;

/** Star toggle for a document card; hover-visible unless starred. */
function StarButton({ starred, pending, onToggle, className }: { starred: boolean; pending: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      disabled={pending}
      aria-busy={pending || undefined}
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

/**
 * Source chip for GitHub-linked documents only; plain Markdoc documents render nothing (#114 — with
 * nothing linked, 52 identical "Markdoc" chips said nothing and wrapped titles early on phone).
 */
function StorageBadge({ doc }: { doc: Doc }) {
  if (doc.storage === "local") return null;
  const detail = doc.storage === "repo" ? `${doc.repoOwner}/${doc.repoName}: ${doc.repoPath}` : `Gist${doc.gistId ? ` ${doc.gistId}` : ""}`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2"
      title={detail}
      data-testid="storage-badge"
      data-storage={doc.storage}
    >
      {doc.storage === "repo" ? <GitBranch size={11} /> : <GitHubIcon size={11} />} GitHub
    </span>
  );
}

export function Dashboard({ user, documents: initialDocuments, githubAvailable, githubConfigured, initialSort = DEFAULT_DASHBOARD_SORT }: DashboardProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(false);
  const clearSearch = useCallback(() => {
    setQuery("");
    searchRef.current?.focus();
  }, []);
  const [openPicker, setOpenPicker] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const filterRef = useRef<Filter>("all");
  const [searchMount] = useState(() => Symbol("dashboard-search"));
  const searchAuthority = useMemo<SearchAuthority>(
    () => ({ mount: searchMount, visit: Symbol("dashboard-user-visit"), user, userId: user.id }),
    [searchMount, user],
  );
  const searchAuthorityRef = useRef<SearchAuthority | null>(null);
  const searchShortcutOwnerRef = useRef<SearchShortcutOwner | null>(null);
  const paletteShortcutOwnerRef = useRef<PaletteShortcutOwner | null>(null);
  const searchDebounceOwner = useRef<SearchDebounceOwner | null>(null);
  const searchRequestOwner = useRef<SearchRequestOwner | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState<SearchDebounceOwner | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searchingOwner, setSearchingOwner] = useState<SearchRequestOwner | null>(null);
  const [searchError, setSearchError] = useState<SearchError | null>(null);

  const [noticeMount] = useState(() => Symbol("dashboard-notice"));
  const noticeAuthority = useMemo<NoticeAuthority>(
    () => ({ mount: noticeMount, userId: user.id }),
    [noticeMount, user.id],
  );
  const noticeAuthorityRef = useRef<NoticeAuthority | null>(null);
  const pendingNoticeConsumedRef = useRef<NoticeAuthority | null>(null);
  const noticePublicationRef = useRef<NoticePublication | null>(null);
  const pendingNoticeTimerRef = useRef<NoticePublication | null>(null);
  const [noticePublication, setNoticePublication] = useState<NoticePublication | null>(null);
  const retireNoticeTimer = useCallback((publication: NoticePublication) => {
    if (publication.timer !== null) {
      clearTimeout(publication.timer);
      publication.timer = null;
    }
    if (pendingNoticeTimerRef.current === publication) pendingNoticeTimerRef.current = null;
  }, []);
  const dismissNotice = useCallback(
    (publication: NoticePublication) => {
      if (noticeAuthorityRef.current !== publication.authority || noticePublicationRef.current !== publication) return;
      retireNoticeTimer(publication);
      noticePublicationRef.current = null;
      setNoticePublication((current) => (current === publication ? null : current));
    },
    [retireNoticeTimer],
  );
  const publishNotice = useCallback(
    (notice: PendingNotice) => {
      if (noticeAuthorityRef.current !== noticeAuthority) return null;
      const publication: NoticePublication = { authority: noticeAuthority, notice, timer: null };
      noticePublicationRef.current = publication;
      setNoticePublication(publication);
      return publication;
    },
    [noticeAuthority],
  );

  useLayoutEffect(() => {
    noticeAuthorityRef.current = noticeAuthority;
    if (noticePublicationRef.current?.authority !== noticeAuthority) noticePublicationRef.current = null;
    setNoticePublication((current) => (current?.authority === noticeAuthority ? current : null));
    return () => {
      if (noticeAuthorityRef.current === noticeAuthority) noticeAuthorityRef.current = null;
      const timerOwner = pendingNoticeTimerRef.current;
      if (timerOwner?.authority === noticeAuthority) retireNoticeTimer(timerOwner);
      if (noticePublicationRef.current?.authority === noticeAuthority) noticePublicationRef.current = null;
    };
  }, [noticeAuthority, retireNoticeTimer]);

  // One-shot message from the page we came from (e.g. the editor after "Move to trash").
  useEffect(() => {
    if (noticeAuthorityRef.current !== noticeAuthority || pendingNoticeConsumedRef.current === noticeAuthority) return;
    pendingNoticeConsumedRef.current = noticeAuthority;
    const pending = takePendingNotice();
    if (!pending) return;
    const publication = publishNotice(pending);
    if (!publication) return;
    const timer = setTimeout(() => {
      if (publication.timer !== timer) return;
      publication.timer = null;
      if (pendingNoticeTimerRef.current === publication) pendingNoticeTimerRef.current = null;
      dismissNotice(publication);
    }, 5000);
    publication.timer = timer;
    pendingNoticeTimerRef.current = publication;
    return () => retireNoticeTimer(publication);
  }, [dismissNotice, noticeAuthority, publishNotice, retireNoticeTimer]);
  const currentNotice = noticePublication?.authority === noticeAuthority ? noticePublication : null;

  // The trash is loaded on demand; `initialDocuments` never contains trashed documents.
  const [trash, setTrash] = useState<Doc[] | null>(null);
  const trashRef = useRef<Doc[] | null>(null);
  const [trashBusyOperation, setTrashBusyOperation] = useState<TrashActionOperation | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const trashErrorRef = useRef<string | null>(null);
  const trashVisitId = useRef(0);
  const trashRequestId = useRef(0);
  const trashRequestPending = useRef(false);
  const trashAction = useRef<TrashActionOperation | null>(null);
  const trashBusy = trashBusyOperation?.documentId ?? null;
  const replaceTrashError = useCallback((error: string | null) => {
    trashErrorRef.current = error;
    setTrashError(error);
  }, []);

  const replaceTrash = useCallback((documents: Doc[]) => {
    const operation = trashAction.current;
    trashRef.current = documents;
    if (operation && !documents.some((document) => document === operation.document)) {
      trashAction.current = null;
      setTrashBusyOperation((current) => (current === operation ? null : current));
    }
    setTrash(documents);
  }, []);

  const loadTrash = useCallback(() => {
    if (filterRef.current !== "trash" || trashRequestPending.current || trashAction.current) return;
    const visit = trashVisitId.current;
    const requestId = ++trashRequestId.current;
    trashRequestPending.current = true;
    setTrashLoading(true);
    const isCurrent = () => filterRef.current === "trash" && visit === trashVisitId.current && requestId === trashRequestId.current;

    void api.documents
      .list({ trash: true })
      .then((res) => {
        if (!isCurrent()) return;
        replaceTrash(res.documents);
        replaceTrashError(null);
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        console.error(err);
        replaceTrashError(apiErrorText(err, "Could not load trash"));
      })
      .finally(() => {
        if (!isCurrent()) return;
        trashRequestPending.current = false;
        setTrashLoading(false);
      });
  }, [replaceTrash, replaceTrashError]);

  const changeFilter = useCallback((next: Filter) => {
    const previous = filterRef.current;
    const leavingTrash = previous === "trash" && next !== "trash";
    const enteringTrash = previous !== "trash" && next === "trash";
    filterRef.current = next;
    if (enteringTrash) trashVisitId.current += 1;
    if (leavingTrash) {
      trashRequestId.current += 1;
      trashRequestPending.current = false;
      const operation = trashAction.current;
      trashAction.current = null;
      setTrashBusyOperation((current) => (current === operation ? null : current));
      setTrashLoading(false);
      replaceTrashError(null);
    }
    setFilter(next);
  }, [replaceTrashError]);

  useEffect(() => {
    if (filter !== "trash") return;
    loadTrash();
  }, [filter, loadTrash]);

  useLayoutEffect(
    () => () => {
      filterRef.current = "all";
      trashVisitId.current += 1;
      trashRequestId.current += 1;
      trashRequestPending.current = false;
      trashAction.current = null;
      trashRef.current = null;
      trashErrorRef.current = null;
    },
    [],
  );

  const canRetryTrash = useCallback(
    (error: string) =>
      filterRef.current === "trash" &&
      trashErrorRef.current === error &&
      !trashRequestPending.current &&
      trashAction.current === null,
    [],
  );
  const retryTrash = useCallback(() => {
    const error = trashErrorRef.current;
    if (error === null || !canRetryTrash(error)) return;
    loadTrash();
  }, [canRetryTrash, loadTrash]);

  const canRunTrashAction = useCallback(
    (doc: Doc) =>
      filterRef.current === "trash" &&
      trashAction.current === null &&
      trashRef.current?.some((document) => document === doc) === true,
    [],
  );
  const runTrashAction = useCallback(async (doc: Doc, kind: TrashActionKind) => {
    if (!canRunTrashAction(doc)) return;
    const operation: TrashActionOperation = { visit: trashVisitId.current, documentId: doc.id, kind, document: doc };
    trashAction.current = operation;
    trashRequestId.current += 1;
    trashRequestPending.current = false;
    setTrashLoading(false);
    setTrashBusyOperation(operation);
    const isCurrent = () =>
      filterRef.current === "trash" &&
      operation.visit === trashVisitId.current &&
      trashAction.current === operation &&
      trashRef.current?.some((document) => document === operation.document);

    try {
      if (kind === "restore") await api.documents.restore(doc.id);
      else await api.documents.delete(doc.id, { permanent: true });
      if (!isCurrent()) return;
      const documents = trashRef.current!.filter((document) => document.id !== operation.documentId);
      trashRef.current = documents;
      setTrash(documents);
      if (kind === "restore") {
        publishNotice({ message: `“${doc.title}” was restored.`, kind: "success" });
        router.refresh();
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      publishNotice({
        message: apiErrorText(err, kind === "restore" ? "Could not restore the document" : "Could not delete the document"),
        kind: "error",
      });
    } finally {
      if (trashAction.current !== operation) return;
      trashAction.current = null;
      setTrashBusyOperation((current) => (current === operation ? null : current));
    }
  }, [canRunTrashAction, publishNotice, router]);
  const restore = useCallback((doc: Doc) => void runTrashAction(doc, "restore"), [runTrashAction]);
  const purge = useCallback(
    (doc: Doc) => {
      if (!canRunTrashAction(doc)) return;
      if (!confirm(`Delete “${doc.title}” forever? This cannot be undone.`)) return;
      void runTrashAction(doc, "purge");
    },
    [canRunTrashAction, runTrashAction],
  );

  // One shared state per id keeps duplicate cards in lockstep and synchronously rejects overlapping writes.
  const [starStates, setStarStates] = useState<Record<string, { confirmed: boolean; value: boolean; pending: boolean }>>({});
  const starStatesRef = useRef(starStates);
  const starRequests = useRef(new Map<string, number>());
  const starRequestId = useRef(0);
  const starPropsRef = useRef(initialDocuments);
  const updateStarState = useCallback((id: string, state: { confirmed: boolean; value: boolean; pending: boolean }) => {
    const next = { ...starStatesRef.current, [id]: state };
    starStatesRef.current = next;
    setStarStates(next);
  }, []);
  const documents = useMemo(
    () => initialDocuments.map((d) => (starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d)),
    [initialDocuments, starStates],
  );
  const toggleStar = useCallback(
    (doc: Doc) => {
      if (starRequests.current.has(doc.id)) return;
      const current = starStatesRef.current[doc.id];
      const confirmed = current?.confirmed ?? doc.starred;
      const next = !(current?.value ?? doc.starred);
      const request = ++starRequestId.current;
      starRequests.current.set(doc.id, request);
      updateStarState(doc.id, { confirmed, value: next, pending: true });

      const update: Promise<{ starred: boolean }> = next ? api.documents.star(doc.id) : api.documents.unstar(doc.id);
      void update.then(
        ({ starred }) => {
          if (starRequests.current.get(doc.id) !== request) return;
          starRequests.current.delete(doc.id);
          updateStarState(doc.id, { confirmed: starred, value: starred, pending: false });
        },
        (error: unknown) => {
          if (starRequests.current.get(doc.id) !== request) return;
          starRequests.current.delete(doc.id);
          updateStarState(doc.id, { confirmed, value: confirmed, pending: false });
          publishNotice({ message: apiErrorText(error, next ? "Could not star document" : "Could not unstar document"), kind: "error" });
        },
      );
    },
    [publishNotice, updateStarState],
  );

  // Sort is remembered per browser in a cookie the server reads (`initialSort`), so the markup already
  // has the saved order and the select's value. localStorage is the fallback for browsers that stored
  // the sort before the cookie existed: when no cookie is set yet, adopt the stored value and write the
  // cookie so the next load is right from the first paint.
  const [sort, setSort] = useState<DashboardSort>(initialSort);
  useEffect(() => {
    try {
      if (readSortCookie() !== null) return;
      const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (!isDashboardSort(saved)) return;
      writeSortCookie(saved);
      setSort(saved);
    } catch {
      // storage unavailable: keep the server's value
    }
  }, []);
  const changeSort = (next: DashboardSort) => {
    setSort(next);
    try {
      writeSortCookie(next);
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  const trimmed = query.trim();

  const retireSearchDebounce = useCallback((owner: SearchDebounceOwner) => {
    if (owner.timer !== null) {
      clearTimeout(owner.timer);
      owner.timer = null;
    }
    if (searchDebounceOwner.current === owner) searchDebounceOwner.current = null;
  }, []);

  const retireSearchRequest = useCallback((owner: SearchRequestOwner) => {
    if (searchRequestOwner.current !== owner) return;
    searchRequestOwner.current = null;
    owner.controller.abort();
  }, []);

  useLayoutEffect(() => {
    searchAuthorityRef.current = searchAuthority;
    return () => {
      if (searchAuthorityRef.current === searchAuthority) searchAuthorityRef.current = null;
      const debounce = searchDebounceOwner.current;
      if (debounce?.authority === searchAuthority) retireSearchDebounce(debounce);
      const request = searchRequestOwner.current;
      if (request?.authority === searchAuthority) retireSearchRequest(request);
    };
  }, [retireSearchDebounce, retireSearchRequest, searchAuthority]);

  useLayoutEffect(() => {
    const target = window;
    const input = searchRef.current;
    if (!input) return;
    const ownsListener = () =>
      owner.active &&
      owner.target === window &&
      owner.input.isConnected &&
      searchRef.current === owner.input &&
      searchShortcutOwnerRef.current === owner &&
      searchAuthorityRef.current === owner.authority &&
      owner.authority === searchAuthority &&
      owner.authority.user === owner.user &&
      owner.user === user &&
      owner.authority.userId === user.id;
    const owner: SearchShortcutOwner = {
      active: true,
      authority: searchAuthority,
      user,
      target,
      input,
      onKeyDown: (event) => {
        if (!ownsListener() || paletteOpenRef.current || !isSearchShortcut(event)) return;
        event.preventDefault();
        if (!ownsListener() || paletteOpenRef.current) return;
        owner.input.focus();
        if (!ownsListener() || paletteOpenRef.current) return;
        owner.input.select();
      },
    };
    searchShortcutOwnerRef.current = owner;
    target.addEventListener("keydown", owner.onKeyDown);
    return () => {
      owner.active = false;
      if (searchShortcutOwnerRef.current === owner) searchShortcutOwnerRef.current = null;
      owner.target.removeEventListener("keydown", owner.onKeyDown);
    };
  }, [searchAuthority, user]);

  // Query and user changes synchronously retire their exact timer and request before parent layout effects run.
  useLayoutEffect(() => {
    setSearchingOwner((current) => (current?.authority === searchAuthority && current.query === trimmed ? current : null));
    if (searchAuthorityRef.current !== searchAuthority || trimmed.length < MIN_QUERY_LENGTH) return;
    const owner: SearchDebounceOwner = { authority: searchAuthority, query: trimmed, timer: null };
    owner.timer = setTimeout(() => {
      if (searchAuthorityRef.current !== searchAuthority || searchDebounceOwner.current !== owner) return;
      owner.timer = null;
      searchDebounceOwner.current = null;
      setDebouncedSearch(owner);
    }, SEARCH_DEBOUNCE_MS);
    searchDebounceOwner.current = owner;

    return () => {
      retireSearchDebounce(owner);
      const request = searchRequestOwner.current;
      if (request?.authority === searchAuthority && request.query === owner.query) retireSearchRequest(request);
    };
  }, [retireSearchDebounce, retireSearchRequest, searchAuthority, trimmed]);

  const runSearch = useCallback(
    (authority: SearchAuthority, requestedQuery: string) => {
      if (searchAuthorityRef.current !== authority || authority !== searchAuthority || authority.userId !== user.id) return;
      const previous = searchRequestOwner.current;
      if (previous) {
        if (previous.authority === authority && previous.query === requestedQuery) return;
        retireSearchRequest(previous);
      }

      const owner: SearchRequestOwner = { authority, query: requestedQuery, controller: new AbortController() };
      searchRequestOwner.current = owner;
      setSearchingOwner(owner);
      const ownsRequest = () =>
        searchAuthorityRef.current === authority &&
        searchRequestOwner.current === owner &&
        !owner.controller.signal.aborted;

      void api.documents
        .search(requestedQuery, { signal: owner.controller.signal })
        .then((res) => {
          if (!ownsRequest()) return;
          setResults({ authority, query: res.query, documents: res.documents });
          setSearchError(null);
        })
        .catch((err: unknown) => {
          if (!ownsRequest()) return;
          console.error(err);
          setSearchError({ authority, query: requestedQuery, message: apiErrorText(err, "Could not search document content") });
        })
        .finally(() => {
          if (!ownsRequest()) return;
          searchRequestOwner.current = null;
          setSearchingOwner((current) => (current === owner ? null : current));
        });

      return () => retireSearchRequest(owner);
    },
    [retireSearchRequest, searchAuthority, user.id],
  );

  useEffect(() => {
    if (debouncedSearch?.authority !== searchAuthority || debouncedSearch.query !== trimmed) return;
    return runSearch(debouncedSearch.authority, debouncedSearch.query);
  }, [debouncedSearch, runSearch, searchAuthority, trimmed]);

  useEffect(() => {
    setSearchError((current) => (current?.authority === searchAuthority && current.query === trimmed ? current : null));
  }, [searchAuthority, trimmed]);

  const searching =
    searchingOwner?.authority === searchAuthority &&
    searchingOwner.query === trimmed;
  const currentSearchError = searchError?.authority === searchAuthority && searchError.query === trimmed ? searchError : null;
  const retrySearch = useCallback(() => {
    if (!currentSearchError || currentSearchError.authority !== searchAuthority || currentSearchError.query !== trimmed || searchRequestOwner.current) return;
    runSearch(searchAuthority, currentSearchError.query);
  }, [currentSearchError, trimmed, runSearch, searchAuthority]);

  // Server results for the current query win; otherwise filter the loaded list by title so typing
  // feels instant while the request is in flight (or for queries too short to send).
  const serverResults =
    !currentSearchError &&
    results?.authority === searchAuthority &&
    trimmed.length >= MIN_QUERY_LENGTH &&
    results.query === trimmed
      ? results.documents
      : null;
  const pending =
    trimmed.length >= MIN_QUERY_LENGTH &&
    !serverResults &&
    (searching || debouncedSearch?.authority !== searchAuthority || debouncedSearch.query !== trimmed);
  useEffect(() => {
    if (starPropsRef.current !== initialDocuments) {
      starPropsRef.current = initialDocuments;
      starRequests.current.clear();
      starStatesRef.current = {};
      setStarStates({});
      return;
    }

    const currentIds = new Set(initialDocuments.map((doc) => doc.id));
    for (const doc of serverResults ?? []) currentIds.add(doc.id);
    const removed = Object.keys(starStatesRef.current).filter((id) => !currentIds.has(id));
    if (removed.length === 0) return;
    const next = { ...starStatesRef.current };
    for (const id of removed) {
      starRequests.current.delete(id);
      delete next[id];
    }
    starStatesRef.current = next;
    setStarStates(next);
  }, [initialDocuments, serverResults]);
  useEffect(
    () => () => {
      starRequests.current.clear();
    },
    [],
  );
  const filtered = useMemo<(Doc & { snippet?: string | null })[]>(() => {
    const matchesFilter = (d: Doc) => {
      if (filter === "mine" && d.ownerId !== user.id) return false;
      if (filter === "shared" && d.ownerId === user.id) return false;
      if (filter === "starred" && !d.starred) return false;
      return true;
    };
    // Search results keep their relevance order (title matches first); the sort applies to the browsing list.
    if (serverResults) return serverResults.map((d) => (starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d)).filter(matchesFilter);
    const q = trimmed.toLowerCase();
    return documents.filter((d) => matchesFilter(d) && (!q || d.title.toLowerCase().includes(q))).sort(compareDocs(sort));
  }, [documents, serverResults, trimmed, filter, sort, user.id, starStates]);

  const starred = useMemo(() => documents.filter((d) => d.starred).sort(compareDocs(sort)), [documents, sort]);
  const showStrip = filter === "all" && !trimmed && starred.length > 0;

  const createOwner = useRef(user.id);
  const createOperation = useRef<CreateOperation | null>(null);
  const [createBusyOperation, setCreateBusyOperation] = useState<CreateOperation | null>(null);
  const creating = createBusyOperation?.ownerId === user.id ? createBusyOperation.key : null;
  const [openTemplates, setOpenTemplates] = useState(false);

  useLayoutEffect(() => {
    const previousOwner = createOwner.current;
    createOwner.current = user.id;
    if (previousOwner === user.id) return;
    const operation = createOperation.current;
    createOperation.current = null;
    setCreateBusyOperation((current) => (current === operation ? null : current));
  }, [user.id]);

  useLayoutEffect(
    () => () => {
      createOperation.current = null;
    },
    [],
  );

  const create = useCallback(
    async (template?: Template) => {
      if (createOperation.current || createOwner.current !== user.id) return;
      const key = template?.id ?? "blank";
      const operation: CreateOperation = { ownerId: user.id, key };
      createOperation.current = operation;
      setCreateBusyOperation(operation);
      const isCurrent = () => createOwner.current === user.id && createOperation.current === operation;
      try {
        const res = await api.documents.create(template ? { template: template.id } : {});
        if (!isCurrent()) return;
        router.push(`/d/${res.document.id}`);
      } catch (err) {
        if (!isCurrent()) return;
        console.error(err);
        publishNotice({ message: apiErrorText(err, "Could not create the document"), kind: "error" });
      } finally {
        if (createOperation.current !== operation) return;
        createOperation.current = null;
        setCreateBusyOperation((current) => (current === operation ? null : current));
      }
    },
    [publishNotice, router, user.id],
  );

  // Command palette (Mod-Shift-P, or Mod-K outside the search box), scoped to dashboard actions.
  // Local files dropped on the page or picked with "Open file…": one file opens straight away,
  // several stay listed in the dialog while the list behind it refreshes — as does a batch with a
  // failure in it, so the failed file stays visible.
  const fileImport = useFileImport({
    onDone: (created, failed) => {
      if (created.length === 1 && failed.length === 0) router.push(`/d/${created[0].id}`);
      else if (created.length > 0) router.refresh();
    },
    onError: (message) => publishNotice({ message, kind: "error" }),
  });
  const pickFile = fileImport.pick;
  useLayoutEffect(() => {
    paletteOpenRef.current = paletteOpen;
    const owner = paletteShortcutOwnerRef.current;
    if (
      owner?.active &&
      owner.authority === searchAuthority &&
      owner.user === user &&
      searchAuthorityRef.current === searchAuthority
    ) {
      owner.open = paletteOpen;
    }
  }, [paletteOpen, searchAuthority, user]);
  useLayoutEffect(() => {
    const target = window;
    const ownsListener = () =>
      owner.active &&
      owner.target === window &&
      paletteShortcutOwnerRef.current === owner &&
      searchAuthorityRef.current === owner.authority &&
      owner.authority === searchAuthority &&
      owner.authority.user === owner.user &&
      owner.user === user &&
      owner.authority.userId === user.id;
    const owner: PaletteShortcutOwner = {
      active: true,
      open: paletteOpenRef.current,
      authority: searchAuthority,
      user,
      target,
      onKeyDown: (event) => {
        if (!ownsListener() || owner.open || paletteOpenRef.current || !isPaletteShortcut(event)) return;
        owner.open = true;
        paletteOpenRef.current = true;
        event.preventDefault();
        if (!ownsListener() || !owner.open || !paletteOpenRef.current) return;
        event.stopPropagation();
        if (!ownsListener() || !owner.open || !paletteOpenRef.current) return;
        setPaletteOpen(true);
      },
    };
    paletteShortcutOwnerRef.current = owner;
    target.addEventListener("keydown", owner.onKeyDown, true);
    return () => {
      owner.active = false;
      if (paletteShortcutOwnerRef.current === owner) paletteShortcutOwnerRef.current = null;
      owner.target.removeEventListener("keydown", owner.onKeyDown, true);
    };
  }, [searchAuthority, user]);
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
        showTrash: () => changeFilter("trash"),
        openFile: pickFile,
        navigate: (href) => router.push(href),
        signOut: () => void signOutSafely(),
      }),
    [create, listDocs, router, pickFile, changeFilter],
  );

  return (
    <TooltipProvider>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} groupOrder={DASHBOARD_GROUPS} />
      <ImportDropzone active={fileImport.dragging} />
      {fileImport.input}
      <ImportDialog open={fileImport.open} onOpenChange={fileImport.setOpen} items={fileImport.items} ignored={fileImport.ignored} />
      <main className="min-h-screen bg-surface-2">
        <header className="app-header sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
          <div className="safe-x mx-auto flex h-16 max-w-6xl items-center gap-3 sm:gap-4 sm:[--safe-pad:1.5rem]">
            <Link href="/" className="flex items-center gap-2.5" aria-label="Markdoc — all documents">
              <Logo className="h-8 w-8" />
              <span className="wordmark hidden text-lg font-semibold text-ink sm:inline">Markdoc</span>
            </Link>
            <div className="relative mx-auto w-full max-w-xl">
              <Search size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
              <input
                ref={searchRef}
                className={cn("input pl-9", query && searching ? "pr-16" : query ? "pr-9" : "pr-9 sm:pr-12")}
                placeholder="Search documents"
                aria-label="Search documents"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  e.preventDefault();
                  // First press clears the query, second press leaves the field (the find bar's Esc convention).
                  if (query) setQuery("");
                  else e.currentTarget.blur();
                }}
                data-testid="search"
              />
              {!query && (
                <span className="pointer-events-none absolute right-3 top-2 hidden text-ink-4 sm:block" aria-hidden="true">
                  <Kbd>/</Kbd>
                </span>
              )}
              {searching && <Loader2 size={16} className={cn("pointer-events-none absolute top-2.5 animate-spin text-ink-4", query ? "right-9" : "right-3")} data-testid="search-loading" />}
              {query && (
                <button
                  type="button"
                  className="absolute right-0 top-0 inline-flex h-9 w-9 items-center justify-center text-ink-3 transition-colors hover:text-ink max-sm:-right-1 max-sm:-top-1 max-sm:h-11 max-sm:w-11"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  data-testid="search-clear"
                >
                  <X size={16} />
                </button>
              )}
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
                <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOutSafely()}>
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
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent">{creating === "blank" ? <Loader2 className="animate-spin" /> : <FilePlus2 size={22} />}</span>
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
                    className="flex items-center gap-1 border-l border-line px-4 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
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
              <button
                type="button"
                onClick={fileImport.pick}
                disabled={creating !== null}
                className="flex items-center gap-1 rounded-r-2xl border-l border-line px-4 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                aria-label="Open file…"
                title="Open file… (.md, .txt, .html)"
                data-testid="open-file"
              >
                <FolderOpen size={16} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setOpenPicker(true)}
              disabled={!githubConfigured}
              title={githubConfigured ? undefined : GITHUB_NOT_CONFIGURED}
              className="group flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition hover:border-accent hover:shadow-md disabled:cursor-default disabled:opacity-60 disabled:hover:border-line disabled:hover:shadow-sm"
              data-testid="open-github"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-inverse text-white">
                <GitHubIcon size={22} />
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-ink">Open from GitHub</span>
                <span className="block text-sm text-ink-3">{githubConfigured ? "Edit a Markdown file from a gist or repository." : GITHUB_NOT_CONFIGURED}</span>
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
                  // ≥ 44 px hit area on phone, ≥ 24 px on desktop (WCAG 2.2 target size, #116); negative
                  // margins pull the padding back so the strip header barely moves.
                  <button
                    type="button"
                    className="-my-2 ml-auto inline-flex min-h-11 items-center px-3 py-2 text-xs font-medium text-accent hover:underline md:-my-0.5 md:min-h-6 md:px-2 md:py-1"
                    onClick={() => setFilter("starred")}
                    data-testid="show-all-starred"
                  >
                    Show all starred ({starred.length})
                  </button>
                )}
              </div>
              <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {starred.slice(0, STARRED_STRIP_MAX).map((d) => (
                  <li key={d.id} className="group relative min-w-0">
                    <Link
                      href={`/d/${d.id}`}
                      className="flex h-full flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2.5 pr-9 shadow-sm transition hover:border-accent hover:shadow-md"
                      data-testid="starred-card"
                    >
                      <span className="line-clamp-2 break-words text-[13px] font-semibold leading-4 text-ink">{d.title}</span>
                      <span className="text-[11px] text-ink-4">{d.lastOpenedAt ? <RelativeTime date={d.lastOpenedAt} prefix="Opened " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                    </Link>
                    <StarButton starred={d.starred} pending={starStates[d.id]?.pending ?? false} onToggle={() => toggleStar(d)} className="absolute right-1.5 top-1.5" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Documents</h2>
            <div className="ml-auto flex min-h-8 max-w-full items-center gap-2 overflow-x-auto max-sm:basis-full" data-testid="dashboard-chips">
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
                    onClick={() => changeFilter(f.value)}
                    aria-pressed={filter === f.value}
                    data-testid={`filter-${f.value}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {currentSearchError && (
            <div className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="search-error">
              <span className="min-w-0 flex-1">
                Content search failed: {currentSearchError.message}. Showing title matches only.
              </span>
              <button type="button" className="btn btn-sm btn-outline shrink-0" onClick={retrySearch} disabled={searching} aria-busy={searching || undefined}>
                {searching ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}

          {filter === "trash" ? (
            <TrashView
              documents={trash}
              busy={trashBusy}
              loading={trashLoading}
              error={trashError}
              canRetry={canRetryTrash}
              canAct={canRunTrashAction}
              onRetry={retryTrash}
              onRestore={restore}
              onPurge={purge}
            />
          ) : filtered.length === 0 && !trimmed && documents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-8" data-testid="empty-state">
              <div className="mb-5 text-center">
                <FileText className="mx-auto mb-3 text-ink-4" size={28} />
                <p className="text-sm font-medium text-ink-2">No documents yet</p>
                <p className="mt-1 text-sm text-ink-3">Start with a short guided document, pick a template, or open a Markdown file from GitHub.</p>
                <button
                  type="button"
                  className="btn btn-primary mt-4 gap-2"
                  onClick={() => void create(getTemplate(WELCOME_TEMPLATE_ID))}
                  disabled={creating !== null}
                  aria-busy={creating === WELCOME_TEMPLATE_ID || undefined}
                  data-testid="start-guided-doc"
                >
                  {creating === WELCOME_TEMPLATE_ID ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Start with a guided doc
                </button>
              </div>
              <TemplateGrid compact onPick={(t) => void create(t)} busy={creating} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
              <FileText className="mx-auto mb-3 text-ink-4" size={28} />
              <p className="text-sm font-medium text-ink-2">
                {pending ? `Searching for "${trimmed}"…` : currentSearchError ? `No title matches for "${trimmed}"` : trimmed ? `No matches for "${trimmed}"` : filter === "starred" ? "No starred documents" : "No matches"}
              </p>
              <p className="mt-1 text-sm text-ink-3">
                {pending ? "Looking through titles and content." : currentSearchError ? "Content results are unavailable. Retry the search above." : filter === "starred" && !trimmed ? "Hover a document and click the star to keep it close." : "Try a different search."}
              </p>
              {trimmed && !pending && (
                <button type="button" className="mt-3 text-sm font-medium text-accent hover:underline" onClick={clearSearch} data-testid="empty-state-clear-search">
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="document-list">
              {filtered.map((d) => (
                <li key={d.id} className="group relative min-w-0" data-testid={trimmed ? "search-result" : undefined}>
                  <Link
                    href={`/d/${d.id}`}
                    className="flex h-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md"
                    data-testid="document-card"
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <h3 className="line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink">
                        <Highlight text={d.title} needle={trimmed} />
                      </h3>
                      <StorageBadge doc={d} />
                    </div>
                    {d.snippet ? (
                      <p className="line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-2" data-testid="search-snippet">
                        <Highlight text={d.snippet} needle={trimmed} />
                      </p>
                    ) : (
                      <p className="line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-3">{d.excerpt || "Empty document"}</p>
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
                  <StarButton starred={d.starred} pending={starStates[d.id]?.pending ?? false} onToggle={() => toggleStar(d)} className="absolute bottom-3 right-3" />
                </li>
              ))}
            </ul>
          )}
        </section>

        <Dialog open={openPicker} onOpenChange={setOpenPicker}>
          <DialogContent title="Open from GitHub" description="Pick a Markdown file. Markdoc keeps a live copy and publishes back when you ask it to." wide>
            <GitHubPicker mode="import" githubAvailable={githubAvailable} githubConfigured={githubConfigured} onImported={(id) => router.push(`/d/${id}`)} />
          </DialogContent>
        </Dialog>

        {currentNotice && (
          <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-white shadow-xl animate-fade-in",
                currentNotice.notice.kind === "error" ? "bg-red-600" : "bg-inverse",
              )}
              role="status"
              data-testid="toast"
              data-kind={currentNotice.notice.kind}
            >
              <span>{currentNotice.notice.message}</span>
              <button type="button" className="text-white/60 hover:text-white" onClick={() => dismissNotice(currentNotice)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          </div>
        )}
      </main>
    </TooltipProvider>
  );
}

interface TrashCardPresentation {
  readonly index: number;
  readonly document: Doc;
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly storage: Doc["storage"];
  readonly repoOwner: string | null;
  readonly repoName: string | null;
  readonly repoPath: string | null;
  readonly gistId: string | null;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly busy: boolean;
}

interface TrashRenderPresentation {
  readonly mount: symbol;
  readonly documents: Doc[] | null;
  readonly busy: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retentionDays: number;
  readonly canRetry: (error: string) => boolean;
  readonly canAct: (document: Doc, kind: TrashActionKind) => boolean;
  readonly onRetry: () => void;
  readonly onRestore: (document: Doc) => void;
  readonly onPurge: (document: Doc) => void;
  readonly cards: readonly TrashCardPresentation[];
}

type TrashPublishedActionKind = "retry" | TrashActionKind;

interface TrashActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
  readonly kind: TrashPublishedActionKind;
  readonly cardIndex: number | null;
}

interface TrashControlPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly kind: TrashPublishedActionKind;
  readonly cardIndex: number | null;
  readonly element: HTMLButtonElement;
  readonly action: TrashActionPublication;
}

interface TrashCardPublication {
  readonly identity: symbol;
  readonly authority: TrashCardPresentation;
  readonly element: HTMLLIElement;
  readonly restore: TrashControlPublication;
  readonly purge: TrashControlPublication;
}

interface TrashDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly relativeTimeText: boolean;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly TrashDomSnapshot[];
}

interface TrashPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface TrashPublication {
  readonly identity: symbol;
  readonly render: TrashRenderPresentation;
  readonly root: HTMLDivElement;
  readonly note: HTMLParagraphElement;
  readonly error: HTMLDivElement | null;
  readonly retry: TrashControlPublication | null;
  readonly loading: HTMLDivElement | null;
  readonly empty: HTMLDivElement | null;
  readonly list: HTMLUListElement | null;
  readonly cards: readonly TrashCardPublication[];
  readonly ownerDocument: Document;
  readonly retire: () => void;
  readonly isRetired: () => boolean;
}

interface TrashElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface TrashRefReplay {
  readonly owner: TrashElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface TrashReplay {
  readonly source: TrashPublication;
  readonly dom: TrashDomSnapshot;
  readonly placement: TrashPlacement;
  readonly partialElements: ReadonlySet<HTMLElement>;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface TrashPublicationCells {
  active: TrashPublication | null;
  successorOf: TrashPublication | null;
  replay: TrashReplay | null;
  readonly retiredPublications: WeakSet<TrashPublication>;
  readonly retiredCards: WeakSet<TrashCardPublication>;
  readonly retiredControls: WeakSet<TrashControlPublication>;
  readonly retiredActions: WeakSet<TrashActionPublication>;
  readonly claimedPublications: WeakSet<TrashPublication>;
  readonly claimedCards: WeakSet<TrashCardPublication>;
  readonly claimedControls: WeakSet<TrashControlPublication>;
  readonly claimedActions: WeakSet<TrashActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly evaluatingPublications: WeakSet<TrashPublication>;
}

interface TrashPublicationRuntime {
  readonly publication: TrashPublication;
  readonly publish: (
    dom: TrashDomSnapshot,
    placement: TrashPlacement,
    owners: readonly TrashElementOwnerView[],
    partialReplayElements: ReadonlySet<HTMLElement>,
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: TrashElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomUnchanged: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly snapshot: () => TrashDomSnapshot | null;
  readonly placement: () => TrashPlacement | null;
  readonly partialReplayElements: () => ReadonlySet<HTMLElement>;
}

interface TrashPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureNote: (element: HTMLParagraphElement | null) => void;
  readonly captureError: (element: HTMLDivElement | null) => void;
  readonly captureRetry: (element: HTMLButtonElement | null) => void;
  readonly captureLoading: (element: HTMLDivElement | null) => void;
  readonly captureEmpty: (element: HTMLDivElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly cards: readonly {
    readonly authority: TrashCardPresentation;
    readonly captureCard: (element: HTMLLIElement | null) => void;
    readonly captureRestore: (element: HTMLButtonElement | null) => void;
    readonly capturePurge: (element: HTMLButtonElement | null) => void;
  }[];
  readonly establish: () => void | (() => void);
  readonly onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onRestore: (card: TrashCardPresentation, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onPurge: (card: TrashCardPresentation, event: ReactMouseEvent<HTMLButtonElement>) => void;
}

const allowTrashRetry = () => true;
const allowTrashAction = () => true;

class TrashElementOwner<T extends HTMLElement> implements TrashElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: TrashElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
    ) => void,
  ) {}

  readonly element = () => this.current;

  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    if (element && this.last && element !== this.last && !element.isConnected) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

function snapshotTrashAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotTrashDom(
  node: Node,
  withinRelativeTime = false,
): TrashDomSnapshot {
  const nextWithinRelativeTime =
    withinRelativeTime ||
    (node.nodeType === node.ELEMENT_NODE &&
      (node as Element).tagName === "TIME");
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    relativeTimeText:
      nextWithinRelativeTime && node.nodeType === node.TEXT_NODE,
    attributes: snapshotTrashAttributes(node),
    children: Object.freeze(
      [...node.childNodes].map((child) =>
        snapshotTrashDom(child, nextWithinRelativeTime),
      ),
    ),
  });
}

function trashDomMatches(snapshot: TrashDomSnapshot, ownerDocument: Document): boolean {
  const { node, children } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    (!snapshot.relativeTimeText && node.nodeValue !== snapshot.nodeValue)
  ) {
    return false;
  }
  const attributes = snapshotTrashAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return (
    node.childNodes.length === children.length &&
    children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        trashDomMatches(child, ownerDocument),
    )
  );
}

function captureTrashPlacement(node: HTMLElement): TrashPlacement | null {
  const parent = node.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: node.ownerDocument,
    parent,
    previousSibling: node.previousSibling,
    nextSibling: node.nextSibling,
  });
}

function trashPlacementMatches(node: HTMLElement, placement: TrashPlacement): boolean {
  return (
    node.ownerDocument === placement.document &&
    node.parentNode === placement.parent &&
    node.previousSibling === placement.previousSibling &&
    node.nextSibling === placement.nextSibling
  );
}

function trashCardMatches(
  card: TrashCardPresentation,
  document: Doc | undefined,
  index: number,
  busy: string | null,
): boolean {
  return (
    Object.isFrozen(card) &&
    card.index === index &&
    document === card.document &&
    document?.id === card.id &&
    document.title === card.title &&
    document.excerpt === card.excerpt &&
    document.storage === card.storage &&
    document.repoOwner === card.repoOwner &&
    document.repoName === card.repoName &&
    document.repoPath === card.repoPath &&
    document.gistId === card.gistId &&
    document.updatedAt === card.updatedAt &&
    document.deletedAt === card.deletedAt &&
    card.busy === (busy === card.id)
  );
}

function trashRenderMatches(render: TrashRenderPresentation): boolean {
  if (
    !Object.isFrozen(render) ||
    !Object.isFrozen(render.cards) ||
    render.retentionDays !== TRASH_RETENTION_DAYS
  ) {
    return false;
  }
  const { documents } = render;
  if (documents === null) return render.cards.length === 0;
  if (documents.length !== render.cards.length) return false;
  return render.cards.every((card, index) =>
    trashCardMatches(card, documents[index], index, render.busy),
  );
}

function trashAuthoritiesMatch(
  previous: TrashRenderPresentation,
  current: TrashRenderPresentation,
): boolean {
  return (
    previous.mount === current.mount &&
    previous.documents === current.documents &&
    previous.busy === current.busy &&
    previous.loading === current.loading &&
    previous.error === current.error &&
    previous.retentionDays === current.retentionDays &&
    previous.canRetry === current.canRetry &&
    previous.canAct === current.canAct &&
    previous.onRetry === current.onRetry &&
    previous.onRestore === current.onRestore &&
    previous.onPurge === current.onPurge &&
    previous.cards.length === current.cards.length &&
    previous.cards.every((card, index) => {
      const candidate = current.cards[index];
      return Boolean(
        candidate &&
          card.index === candidate.index &&
          card.document === candidate.document &&
          card.id === candidate.id &&
          card.title === candidate.title &&
          card.excerpt === candidate.excerpt &&
          card.storage === candidate.storage &&
          card.repoOwner === candidate.repoOwner &&
          card.repoName === candidate.repoName &&
          card.repoPath === candidate.repoPath &&
          card.gistId === candidate.gistId &&
          card.updatedAt === candidate.updatedAt &&
          card.deletedAt === candidate.deletedAt &&
          card.busy === candidate.busy,
      );
    }) &&
    trashRenderMatches(previous) &&
    trashRenderMatches(current)
  );
}

function trashIsEffectivelyEnabled(element: HTMLElement): boolean {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true" ||
    element.getAttribute("aria-busy")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function createTrashPublication(
  render: TrashRenderPresentation,
  cells: TrashPublicationCells,
  requestSuccessor: () => void,
): TrashPublicationSet {
  const mount = render.mount;
  const documents = render.documents;
  const busy = render.busy;
  const loading = render.loading;
  const error = render.error;
  const retentionDays = render.retentionDays;
  const canRetry = render.canRetry;
  const canAct = render.canAct;
  const onRetry = render.onRetry;
  const onRestore = render.onRestore;
  const onPurge = render.onPurge;
  const cards = render.cards;
  let currentRuntime: TrashPublicationRuntime | null = null;
  let lastRuntime: TrashPublicationRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = () =>
    render.mount === mount &&
    render.documents === documents &&
    render.busy === busy &&
    render.loading === loading &&
    render.error === error &&
    render.retentionDays === retentionDays &&
    render.canRetry === canRetry &&
    render.canAct === canAct &&
    render.onRetry === onRetry &&
    render.onRestore === onRestore &&
    render.onPurge === onPurge &&
    render.cards === cards &&
    trashRenderMatches(render);

  const onElementChange = (
    owner: TrashElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };

  const rootOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const noteOwner = new TrashElementOwner<HTMLParagraphElement>(onElementChange);
  const errorOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const retryOwner = new TrashElementOwner<HTMLButtonElement>(onElementChange);
  const loadingOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const emptyOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const listOwner = new TrashElementOwner<HTMLUListElement>(onElementChange);
  const cardOwners = Object.freeze(
    cards.map((card) => {
      const cardOwner = new TrashElementOwner<HTMLLIElement>(onElementChange);
      const restoreOwner = new TrashElementOwner<HTMLButtonElement>(onElementChange);
      const purgeOwner = new TrashElementOwner<HTMLButtonElement>(onElementChange);
      return Object.freeze({
        authority: card,
        captureCard: cardOwner.capture,
        captureRestore: restoreOwner.capture,
        capturePurge: purgeOwner.capture,
        cardOwner,
        restoreOwner,
        purgeOwner,
      });
    }),
  );

  const hasError = Boolean(error);
  const hasLoading = documents === null && !hasError;
  const hasEmpty = documents !== null && documents.length === 0;
  const hasList = documents !== null && documents.length > 0;
  const expectedOwners = (): readonly TrashElementOwnerView[] => [
    rootOwner,
    noteOwner,
    ...(hasError ? [errorOwner, retryOwner] : []),
    ...(hasLoading ? [loadingOwner] : []),
    ...(hasEmpty ? [emptyOwner] : []),
    ...(hasList ? [listOwner] : []),
    ...cardOwners.flatMap(({ cardOwner, restoreOwner, purgeOwner }) => [
      cardOwner,
      restoreOwner,
      purgeOwner,
    ]),
  ];

  const exactDomIsCurrent = () => {
    if (!factsAreCurrent()) return false;
    const root = rootOwner.element();
    const note = noteOwner.element();
    const errorElement = errorOwner.element();
    const retry = retryOwner.element();
    const loadingElement = loadingOwner.element();
    const empty = emptyOwner.element();
    const list = listOwner.element();
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !root ||
      !root.isConnected ||
      !root.parentNode ||
      !ownerDocument ||
      !ownerWindow ||
      !(root instanceof ownerWindow.HTMLDivElement) ||
      root.dataset.testid !== "trash-view" ||
      root.getAttribute("aria-busy") !== (loading ? "true" : null) ||
      !(note instanceof ownerWindow.HTMLParagraphElement) ||
      !note.isConnected ||
      note.ownerDocument !== ownerDocument ||
      note.parentElement !== root ||
      root.firstElementChild !== note ||
      note.className !== "mb-3 flex items-center gap-1.5 text-xs text-ink-3" ||
      note.dataset.testid !== "trash-note" ||
      note.textContent?.trim() !== `Items are deleted forever after ${retentionDays} days.`
    ) {
      return false;
    }

    let rootIndex = 1;
    if (hasError) {
      const errorText = errorElement?.firstElementChild;
      if (
        !(errorElement instanceof ownerWindow.HTMLDivElement) ||
        !errorElement.isConnected ||
        errorElement.ownerDocument !== ownerDocument ||
        errorElement.parentElement !== root ||
        root.children.item(rootIndex++) !== errorElement ||
        errorElement.className !== "mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" ||
        errorElement.getAttribute("role") !== "alert" ||
        errorElement.getAttribute("aria-atomic") !== "true" ||
        errorElement.dataset.testid !== "trash-error" ||
        errorElement.children.length !== 2 ||
        !(errorText instanceof ownerWindow.HTMLSpanElement) ||
        errorText.className !== "min-w-0 flex-1" ||
        errorText.textContent !== error ||
        !(retry instanceof ownerWindow.HTMLButtonElement) ||
        !retry.isConnected ||
        retry.ownerDocument !== ownerDocument ||
        retry.parentElement !== errorElement ||
        errorElement.lastElementChild !== retry ||
        retry.type !== "button" ||
        retry.className !== "btn btn-sm btn-outline shrink-0 gap-1.5" ||
        retry.disabled !== loading ||
        retry.getAttribute("aria-busy") !== (loading ? "true" : null) ||
        retry.textContent?.trim() !== (loading ? "Retrying…" : "Retry") ||
        (!loading && !trashIsEffectivelyEnabled(retry))
      ) {
        return false;
      }
    } else if (errorElement !== null || retry !== null) {
      return false;
    }

    const stateElement = hasLoading ? loadingElement : hasEmpty ? empty : hasList ? list : null;
    if (stateElement !== null) {
      if (
        !stateElement.isConnected ||
        stateElement.ownerDocument !== ownerDocument ||
        stateElement.parentElement !== root ||
        root.children.item(rootIndex) !== stateElement
      ) {
        return false;
      }
      rootIndex++;
    }
    if (
      root.children.length !== rootIndex ||
      (hasLoading ? loadingElement === null : loadingElement !== null) ||
      (hasEmpty ? empty === null : empty !== null) ||
      (hasList ? list === null : list !== null)
    ) {
      return false;
    }

    if (hasLoading) {
      if (
        !(loadingElement instanceof ownerWindow.HTMLDivElement) ||
        loadingElement.className !== "flex items-center gap-2 py-10 text-sm text-ink-3" ||
        loadingElement.textContent?.trim() !== "Loading trash…"
      ) {
        return false;
      }
    } else if (hasEmpty) {
      if (
        !(empty instanceof ownerWindow.HTMLDivElement) ||
        empty.className !== "rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" ||
        empty.dataset.testid !== "empty-state" ||
        empty.children.length !== 3 ||
        empty.children.item(1)?.textContent !== "The trash is empty" ||
        empty.children.item(2)?.textContent !==
          `Documents you move to the trash can be restored here for ${retentionDays} days.`
      ) {
        return false;
      }
    } else if (
      hasList &&
      (!(list instanceof ownerWindow.HTMLUListElement) ||
        list.className !== "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" ||
        list.dataset.testid !== "trash-list" ||
        list.children.length !== cards.length)
    ) {
      return false;
    }

    if (!hasList) return cardOwners.length === 0;
    if (!list) return false;
    return cardOwners.every((owned, index) => {
      const card = owned.authority;
      const item = owned.cardOwner.element();
      const restore = owned.restoreOwner.element();
      const purge = owned.purgeOwner.element();
      if (
        cards[index] !== card ||
        !(item instanceof ownerWindow.HTMLLIElement) ||
        !item.isConnected ||
        item.ownerDocument !== ownerDocument ||
        item.parentElement !== list ||
        list.children.item(index) !== item ||
        item.className !== "flex h-full min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm" ||
        item.dataset.testid !== "trash-card" ||
        item.getAttribute("aria-busy") !== (card.busy ? "true" : null) ||
        item.children.length !== 3
      ) {
        return false;
      }
      const header = item.children.item(0);
      const excerpt = item.children.item(1);
      const footer = item.children.item(2);
      const storageBadge = header?.children.item(1);
      const storageDetail =
        card.storage === "repo"
          ? `${card.repoOwner}/${card.repoName}: ${card.repoPath}`
          : `Gist${card.gistId ? ` ${card.gistId}` : ""}`;
      if (
        !(header instanceof ownerWindow.HTMLDivElement) ||
        header.className !== "mb-2 flex items-start justify-between gap-2" ||
        header.children.length !== (card.storage === "local" ? 1 : 2) ||
        header.firstElementChild?.tagName !== "H3" ||
        header.firstElementChild.className !== "line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink" ||
        header.firstElementChild.textContent !== card.title ||
        (card.storage === "local"
          ? storageBadge !== null
          : !(storageBadge instanceof ownerWindow.HTMLSpanElement) ||
            storageBadge.className !== "inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2" ||
            storageBadge.getAttribute("title") !== storageDetail ||
            storageBadge.dataset.testid !== "storage-badge" ||
            storageBadge.dataset.storage !== card.storage ||
            storageBadge.textContent?.trim() !== "GitHub") ||
        !(excerpt instanceof ownerWindow.HTMLParagraphElement) ||
        excerpt.className !== "line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-3" ||
        excerpt.textContent !== (card.excerpt || "Empty document") ||
        !(footer instanceof ownerWindow.HTMLDivElement) ||
        footer.className !== "mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-4" ||
        footer.children.length !== 2
      ) {
        return false;
      }
      const timeContainer = footer.children.item(0);
      const controls = footer.children.item(1);
      const time = timeContainer?.firstElementChild;
      const displayedDate = card.deletedAt ?? card.updatedAt;
      if (
        !(timeContainer instanceof ownerWindow.HTMLSpanElement) ||
        timeContainer.className !== "whitespace-nowrap" ||
        timeContainer.children.length !== 1 ||
        !(time instanceof ownerWindow.HTMLTimeElement) ||
        time.getAttribute("datetime") !== new Date(displayedDate).toISOString() ||
        !(controls instanceof ownerWindow.HTMLDivElement) ||
        controls.className !== "ml-auto flex items-center gap-1.5" ||
        controls.children.length !== 2 ||
        !(restore instanceof ownerWindow.HTMLButtonElement) ||
        !restore.isConnected ||
        restore.ownerDocument !== ownerDocument ||
        restore.parentElement !== controls ||
        controls.firstElementChild !== restore ||
        restore.type !== "button" ||
        restore.className !== "btn btn-sm btn-outline gap-1 whitespace-nowrap" ||
        restore.disabled !== (busy !== null) ||
        restore.dataset.testid !== "restore-button" ||
        restore.textContent?.trim() !== "Restore" ||
        !(purge instanceof ownerWindow.HTMLButtonElement) ||
        !purge.isConnected ||
        purge.ownerDocument !== ownerDocument ||
        purge.parentElement !== controls ||
        controls.lastElementChild !== purge ||
        purge.type !== "button" ||
        purge.className !== "btn btn-sm gap-1 whitespace-nowrap text-danger hover:bg-red-50 dark:hover:bg-red-950/40" ||
        purge.disabled !== (busy !== null) ||
        purge.dataset.testid !== "purge-button" ||
        purge.textContent?.trim() !== "Delete forever" ||
        (busy === null &&
          (!trashIsEffectivelyEnabled(restore) || !trashIsEffectivelyEnabled(purge)))
      ) {
        return false;
      }
      return true;
    });
  };

  const publicationWasClaimed = (publication: TrashPublication) =>
    cells.claimedPublications.has(publication);

  const requestReplaySuccessor = (runtime: TrashPublicationRuntime) => {
    const dom = runtime.snapshot();
    const placement = runtime.placement();
    if (
      successorRequested ||
      !dom ||
      !placement ||
      cells.successorOf !== runtime.publication ||
      publicationWasClaimed(runtime.publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay = Object.freeze({
      source: runtime.publication,
      dom,
      placement,
      partialElements: runtime.partialReplayElements(),
      unchanged: runtime.replayDomUnchanged,
      release: runtime.releaseReplayGuard,
    });
    requestSuccessor();
  };

  const createRuntime = (): TrashPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const root = rootOwner.element();
    const note = noteOwner.element();
    const errorElement = errorOwner.element();
    const retryElement = retryOwner.element();
    const loadingElement = loadingOwner.element();
    const emptyElement = emptyOwner.element();
    const listElement = listOwner.element();
    const placement = root ? captureTrashPlacement(root) : null;
    if (
      !root ||
      !note ||
      !placement ||
      (hasError ? !errorElement || !retryElement : Boolean(errorElement || retryElement)) ||
      (hasLoading ? !loadingElement : Boolean(loadingElement)) ||
      (hasEmpty ? !emptyElement : Boolean(emptyElement)) ||
      (hasList ? !listElement : Boolean(listElement)) ||
      cardOwners.some(
        ({ cardOwner, restoreOwner, purgeOwner }) =>
          !cardOwner.element() || !restoreOwner.element() || !purgeOwner.element(),
      )
    ) {
      return null;
    }

    const identity = Symbol("trash-publication");
    const control = (
      kind: TrashPublishedActionKind,
      cardIndex: number | null,
      element: HTMLButtonElement,
    ): TrashControlPublication => {
      const controlIdentity = Symbol(`trash-${kind}-control`);
      return Object.freeze({
        identity: controlIdentity,
        publicationIdentity: identity,
        kind,
        cardIndex,
        element,
        action: Object.freeze({
          identity: Symbol(`trash-${kind}-action`),
          publicationIdentity: identity,
          controlIdentity,
          kind,
          cardIndex,
        }),
      });
    };
    const publishedCards = Object.freeze(
      cardOwners.map((owned) => {
        const element = owned.cardOwner.element();
        const restore = owned.restoreOwner.element();
        const purge = owned.purgeOwner.element();
        if (!element || !restore || !purge) {
          throw new Error("Cannot publish a Trash row without every committed ref");
        }
        return Object.freeze({
          identity: Symbol("trash-card"),
          authority: owned.authority,
          element,
          restore: control("restore", owned.authority.index, restore),
          purge: control("purge", owned.authority.index, purge),
        });
      }),
    );
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domChanged = false;
    let domObserver: MutationObserver | null = null;
    let domSnapshot: TrashDomSnapshot | null = null;
    let relativeTimeTextNodes = new WeakSet<Node>();
    let publishedPlacement: TrashPlacement | null = null;
    let replayRefs: TrashRefReplay[] = [];
    let partialReplayOwners = new Set<TrashElementOwnerView>();
    let invalidReplay = false;
    const publication: TrashPublication = Object.freeze({
      identity,
      render,
      root,
      note,
      error: hasError ? errorElement : null,
      retry: hasError && retryElement ? control("retry", null, retryElement) : null,
      loading: hasLoading ? loadingElement : null,
      empty: hasEmpty ? emptyElement : null,
      list: hasList ? listElement : null,
      cards: publishedCards,
      ownerDocument: root.ownerDocument,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const mutationIsRelevant = (record: MutationRecord) => {
      if (
        record.type === "characterData" &&
        relativeTimeTextNodes.has(record.target)
      ) {
        return false;
      }
      if (record.target === root || root.contains(record.target)) return true;
      if (
        record.type === "attributes" &&
        (record.attributeName === "inert" ||
          record.attributeName === "aria-disabled" ||
          record.attributeName === "aria-busy" ||
          record.attributeName === "disabled") &&
        record.target.contains(root)
      ) {
        return true;
      }
      if (record.type !== "childList") return false;
      if (publishedPlacement && record.target === publishedPlacement.parent) return true;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === root || node.contains(root) || root.contains(node),
      );
    };
    const recordMutations = (records: readonly MutationRecord[]) => {
      if (!domChanged && records.some(mutationIsRelevant)) domChanged = true;
      return domChanged;
    };
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      recordMutations(domObserver.takeRecords());
      domObserver.disconnect();
      domObserver = null;
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) recordMutations(domObserver.takeRecords());
      retired = true;
      retirement = reason;
      cells.retiredPublications.add(publication);
      for (const card of publication.cards) {
        cells.retiredCards.add(card);
        for (const publishedControl of [card.restore, card.purge]) {
          cells.retiredControls.add(publishedControl);
          cells.retiredActions.add(publishedControl.action);
        }
      }
      if (publication.retry) {
        cells.retiredControls.add(publication.retry);
        cells.retiredActions.add(publication.retry.action);
      }
      const wasActive = cells.active === publication;
      if (wasActive) {
        cells.active = null;
        cells.successorOf = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      if (reason === "layout" || reason === "element") {
        queueMicrotask(() => {
          if (!domObserver) return;
          recordMutations(domObserver.takeRecords());
          domChanged = true;
          domObserver.disconnect();
          domObserver = null;
        });
      } else {
        releaseReplayGuard();
      }
      return wasActive;
    };
    const noteMutations = (records: readonly MutationRecord[]) => {
      if (recordMutations(records)) retire("element");
    };
    const publishedDomMatches = () => {
      if (domObserver) noteMutations(domObserver.takeRecords());
      return Boolean(
        !domChanged &&
          domSnapshot &&
          publishedPlacement &&
          rootOwner.element() === root &&
          noteOwner.element() === note &&
          root.isConnected &&
          trashPlacementMatches(root, publishedPlacement) &&
          trashDomMatches(domSnapshot, publication.ownerDocument),
      );
    };
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactPartialReplay = () =>
      !invalidReplay &&
      partialReplayOwners.size > 0 &&
      replayRefs.every(
        (entry) =>
          entry.owner.element() === entry.element &&
          (partialReplayOwners.has(entry.owner)
            ? entry.detached && entry.reattached
            : !entry.detached && !entry.reattached),
      );
    const runtime: TrashPublicationRuntime = Object.freeze({
      publication,
      publish: (
        nextDom: TrashDomSnapshot,
        nextPlacement: TrashPlacement,
        owners: readonly TrashElementOwnerView[],
        partialReplayElements: ReadonlySet<HTMLElement>,
      ) => {
        established = true;
        domSnapshot = nextDom;
        relativeTimeTextNodes = new WeakSet<Node>();
        const rememberRelativeTimeText = (snapshot: TrashDomSnapshot) => {
          if (snapshot.relativeTimeText) {
            relativeTimeTextNodes.add(snapshot.node);
          }
          snapshot.children.forEach(rememberRelativeTimeText);
        };
        rememberRelativeTimeText(nextDom);
        publishedPlacement = nextPlacement;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error("Cannot publish Trash without every committed ref");
          }
          return { owner, element, detached: false, reattached: false };
        });
        partialReplayOwners = new Set(
          replayRefs
            .filter(({ element }) => partialReplayElements.has(element))
            .map(({ owner }) => owner),
        );
        cells.active = publication;
        cells.successorOf = null;
        cells.replay = null;
        const MutationObserverConstructor =
          publication.ownerDocument.defaultView?.MutationObserver;
        if (MutationObserverConstructor) {
          domObserver = new MutationObserverConstructor((records) => {
            noteMutations(records);
          });
          domObserver.observe(publication.ownerDocument, {
            attributeOldValue: true,
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: TrashElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (
          element === null &&
          previous === proof.element &&
          proof.element.isConnected
        ) {
          proof.detached = true;
          proof.reattached = false;
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached &&
          proof.element.isConnected
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      isRetired: () => retired,
      publishedDomMatches,
      isExactElementReplay: () =>
          retired &&
          retirement === "element" &&
          established &&
          (layoutRetired ? refsHaveExactReplay() : refsHaveExactPartialReplay()) &&
          publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      replayDomUnchanged: () => {
        if (!domObserver) return false;
        recordMutations(domObserver.takeRecords());
        return Boolean(
          !domChanged &&
            domSnapshot &&
            publishedPlacement &&
            root.isConnected &&
            trashPlacementMatches(root, publishedPlacement) &&
            trashDomMatches(domSnapshot, publication.ownerDocument),
        );
      },
      releaseReplayGuard,
      snapshot: () => domSnapshot,
      placement: () => publishedPlacement,
      partialReplayElements: () =>
        new Set(
          replayRefs
            .filter(({ owner }) => partialReplayOwners.has(owner))
            .map(({ element }) => element),
        ),
    });
    return runtime;
  };

  const publishedElements = (publication: TrashPublication): readonly HTMLElement[] => [
    publication.root,
    publication.note,
    ...(publication.error ? [publication.error] : []),
    ...(publication.retry ? [publication.retry.element] : []),
    ...(publication.loading ? [publication.loading] : []),
    ...(publication.empty ? [publication.empty] : []),
    ...(publication.list ? [publication.list] : []),
    ...publication.cards.flatMap((card) => [
      card.element,
      card.restore.element,
      card.purge.element,
    ]),
  ];

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        cells.successorOf === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    if (!root) return undefined;
    const placement = captureTrashPlacement(root);
    if (!placement) return undefined;
    const replay = cells.replay;
    if (
      replay &&
      (cells.successorOf !== replay.source ||
        publicationWasClaimed(replay.source) ||
        !trashAuthoritiesMatch(replay.source.render, render) ||
        replay.dom.node !== root ||
        !trashPlacementMatches(root, replay.placement) ||
        !trashDomMatches(replay.dom, root.ownerDocument) ||
        !replay.unchanged())
    ) {
      const exactDomStillCommitted =
        replay.dom.node === root &&
        trashPlacementMatches(root, replay.placement) &&
        trashDomMatches(replay.dom, root.ownerDocument) &&
        replay.unchanged();
      replay.release();
      cells.replay = null;
      if (cells.successorOf === replay.source) cells.successorOf = null;
      if (exactDomStillCommitted) requestSuccessor();
      return undefined;
    }

    const runtime = createRuntime();
    if (!runtime) return undefined;
    const publication = runtime.publication;
    const previous = cells.active;
    const predecessor = previous ?? cells.successorOf;
    const predecessorElements = new Set<HTMLElement>(
      predecessor?.render.mount === mount ? publishedElements(predecessor) : [],
    );
    const partialReplayElements = new Set<HTMLElement>(
      expectedOwners()
        .map((owner) => owner.element())
        .filter(
          (element): element is HTMLElement =>
            Boolean(
              element &&
                (!predecessorElements.has(element) ||
                  replay?.partialElements.has(element)),
            ),
        ),
    );
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotTrashDom(root),
      placement,
      expectedOwners(),
      partialReplayElements,
    );
    replay?.release();
    return runtime.retireForLayout;
  };

  const nativeClick = (
    publication: TrashPublication,
    control: HTMLButtonElement,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): MouseEvent | null => {
    if (!event || typeof event !== "object") return null;
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const reactEventPrototype = Object.getPrototypeOf(event) as {
      constructor?: { name?: unknown };
    } | null;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      !(target instanceof ownerWindow.Node) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.type !== "click" ||
      event.button !== 0 ||
      !event.bubbles ||
      event.currentTarget !== control ||
      target !== nativeEvent.target ||
      target.ownerDocument !== publication.ownerDocument ||
      !control.isConnected ||
      control.ownerDocument !== publication.ownerDocument ||
      !control.contains(target) ||
      !nativeEvent.composedPath().includes(control) ||
      !nativeEvent.composedPath().includes(publication.root) ||
      reactEventPrototype?.constructor?.name !== "SyntheticBaseEvent" ||
      reactEvent._reactName !== "onClick" ||
      typeof reactEvent.isDefaultPrevented !== "function" ||
      typeof reactEvent.isPropagationStopped !== "function" ||
      typeof reactEvent.persist !== "function"
    ) {
      return null;
    }
    const targetWasCommitted = (snapshot: TrashDomSnapshot): boolean =>
      snapshot.node === target ||
      snapshot.children.some(targetWasCommitted);
    const snapshot = currentRuntime?.snapshot();
    return snapshot && targetWasCommitted(snapshot) ? nativeEvent : null;
  };

  const candidateIsCurrent = (
    runtime: TrashPublicationRuntime,
    publication: TrashPublication,
    card: TrashCardPublication | null,
    control: TrashControlPublication,
    action: TrashActionPublication,
  ) =>
    currentRuntime === runtime &&
    !runtime.isRetired() &&
    !publication.isRetired() &&
    cells.active === publication &&
    publication.render === render &&
    control.publicationIdentity === publication.identity &&
    action.publicationIdentity === publication.identity &&
    action.controlIdentity === control.identity &&
    action.kind === control.kind &&
    action.cardIndex === control.cardIndex &&
    !cells.retiredPublications.has(publication) &&
    !cells.retiredControls.has(control) &&
    !cells.retiredActions.has(action) &&
    !cells.claimedPublications.has(publication) &&
    !cells.claimedControls.has(control) &&
    !cells.claimedActions.has(action) &&
    (card === null
      ? control === publication.retry &&
        control.kind === "retry" &&
        control.cardIndex === null
      : publication.cards[card.authority.index] === card &&
        card.authority === cards[card.authority.index] &&
        control === (control.kind === "restore" ? card.restore : card.purge) &&
        control.cardIndex === card.authority.index &&
        !cells.retiredCards.has(card) &&
        !cells.claimedCards.has(card)) &&
    factsAreCurrent() &&
    exactDomIsCurrent() &&
    runtime.publishedDomMatches();

  const claim = (
    kind: TrashPublishedActionKind,
    card: TrashCardPresentation | null,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): {
    publication: TrashPublication;
    card: TrashCardPublication | null;
    release: () => void;
  } | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedCard =
      publication && card && cards[card.index] === card
        ? publication.cards[card.index]
        : null;
    const control =
      kind === "retry"
        ? publication?.retry
        : kind === "restore"
          ? publishedCard?.restore
          : publishedCard?.purge;
    const action = control?.action;
    if (
      !runtime ||
      !publication ||
      !control ||
      !action ||
      control.kind !== kind ||
      !candidateIsCurrent(runtime, publication, publishedCard, control, action)
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, control.element, event);
    if (
      !nativeEvent ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent) ||
      cells.evaluatingPublications.has(publication)
    ) {
      return null;
    }

    cells.evaluatingPublications.add(publication);
    let eligible = false;
    try {
      eligible =
        kind === "retry"
          ? Boolean(error) && !loading && render.canRetry(error!)
          : publishedCard !== null &&
            busy === null &&
            render.canAct(publishedCard.authority.document, kind);
    } finally {
      cells.evaluatingPublications.delete(publication);
    }
    if (
      !eligible ||
      !candidateIsCurrent(runtime, publication, publishedCard, control, action) ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent)
    ) {
      return null;
    }

    cells.claimedPublications.add(publication);
    if (publishedCard) cells.claimedCards.add(publishedCard);
    cells.claimedControls.add(control);
    cells.claimedActions.add(action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    return {
      publication,
      card: publishedCard,
      release: () => {
        cells.claimedPublications.delete(publication);
        if (publishedCard) cells.claimedCards.delete(publishedCard);
        cells.claimedControls.delete(control);
        cells.claimedActions.delete(action);
      },
    };
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureNote: noteOwner.capture,
    captureError: errorOwner.capture,
    captureRetry: retryOwner.capture,
    captureLoading: loadingOwner.capture,
    captureEmpty: emptyOwner.capture,
    captureList: listOwner.capture,
    cards: cardOwners,
    establish,
    onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => {
      const claimed = claim("retry", null, event);
      if (!claimed) return;
      try {
        claimed.publication.render.onRetry();
      } finally {
        claimed.release();
      }
    },
    onRestore: (
      card: TrashCardPresentation,
      event: ReactMouseEvent<HTMLButtonElement>,
    ) => {
      const claimed = claim("restore", card, event);
      if (claimed?.card) {
        try {
          claimed.publication.render.onRestore(claimed.card.authority.document);
        } finally {
          claimed.release();
        }
      }
    },
    onPurge: (
      card: TrashCardPresentation,
      event: ReactMouseEvent<HTMLButtonElement>,
    ) => {
      const claimed = claim("purge", card, event);
      if (claimed?.card) {
        try {
          claimed.publication.render.onPurge(claimed.card.authority.document);
        } finally {
          claimed.release();
        }
      }
    },
  });
}

/** The caller's trashed documents: not openable; restore or delete forever. `documents` is null until the first successful load. */
export function TrashView({
  documents,
  busy,
  loading,
  error,
  canRetry = allowTrashRetry,
  canAct = allowTrashAction,
  onRetry,
  onRestore,
  onPurge,
}: {
  documents: Doc[] | null;
  busy: string | null;
  loading: boolean;
  error: string | null;
  canRetry?: (error: string) => boolean;
  canAct?: (document: Doc, kind: TrashActionKind) => boolean;
  onRetry: () => void;
  onRestore: (d: Doc) => void;
  onPurge: (d: Doc) => void;
}) {
  const [mount] = useState(() => Symbol("trash-view"));
  const [cells] = useState<TrashPublicationCells>(() => ({
    active: null,
    successorOf: null,
    replay: null,
    retiredPublications: new WeakSet(),
    retiredCards: new WeakSet(),
    retiredControls: new WeakSet(),
    retiredActions: new WeakSet(),
    claimedPublications: new WeakSet(),
    claimedCards: new WeakSet(),
    claimedControls: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    evaluatingPublications: new WeakSet(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const cards = Object.freeze(
    (documents ?? []).map(
      (document, index): TrashCardPresentation =>
        Object.freeze({
          index,
          document,
          id: document.id,
          title: document.title,
          excerpt: document.excerpt,
          storage: document.storage,
          repoOwner: document.repoOwner,
          repoName: document.repoName,
          repoPath: document.repoPath,
          gistId: document.gistId,
          updatedAt: document.updatedAt,
          deletedAt: document.deletedAt,
          busy: busy === document.id,
        }),
    ),
  );
  const presentation: TrashRenderPresentation = Object.freeze({
    mount,
    documents,
    busy,
    loading,
    error,
    retentionDays: TRASH_RETENTION_DAYS,
    canRetry,
    canAct,
    onRetry,
    onRestore,
    onPurge,
    cards,
  });
  const publication = createTrashPublication(
    presentation,
    cells,
    requestPublicationSuccessor,
  );
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureRoot,
    captureNote,
    captureError,
    captureRetry,
    captureLoading,
    captureEmpty,
    captureList,
    cards: publishedCards,
    onRetry: publishRetry,
    onRestore: publishRestore,
    onPurge: publishPurge,
  } = publication;

  return (
    <div ref={captureRoot} data-testid="trash-view" aria-busy={presentation.loading || undefined}>
      <p ref={captureNote} className="mb-3 flex items-center gap-1.5 text-xs text-ink-3" data-testid="trash-note">
        <Trash2 size={12} /> Items are deleted forever after {presentation.retentionDays} days.
      </p>
      {presentation.error && (
        <div
          ref={captureError}
          className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          role="alert"
          aria-atomic="true"
          data-testid="trash-error"
        >
          <span className="min-w-0 flex-1">{presentation.error}</span>
          <button
            ref={captureRetry}
            type="button"
            className="btn btn-sm btn-outline shrink-0 gap-1.5"
            onClick={publishRetry}
            disabled={presentation.loading}
            aria-busy={presentation.loading || undefined}
          >
            {presentation.loading && <Loader2 size={13} className="animate-spin" />}
            {presentation.loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {presentation.documents === null && !presentation.error ? (
        <div ref={captureLoading} className="flex items-center gap-2 py-10 text-sm text-ink-3">
          <Loader2 size={16} className="animate-spin" /> Loading trash…
        </div>
      ) : presentation.documents?.length === 0 ? (
        <div ref={captureEmpty} className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
          <Trash2 className="mx-auto mb-3 text-ink-4" size={28} />
          <p className="text-sm font-medium text-ink-2">The trash is empty</p>
          <p className="mt-1 text-sm text-ink-3">Documents you move to the trash can be restored here for {presentation.retentionDays} days.</p>
        </div>
      ) : presentation.documents ? (
        <ul ref={captureList} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="trash-list">
          {publishedCards.map((publishedCard) => {
            const card = publishedCard.authority;
            const d = card.document;
            return (
              <li
                ref={publishedCard.captureCard}
                key={card.id}
                className="flex h-full min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm"
                data-testid="trash-card"
                aria-busy={card.busy || undefined}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink">{card.title}</h3>
                  <StorageBadge doc={d} />
                </div>
                <p className="line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-3">{card.excerpt || "Empty document"}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-4">
                  <span className="whitespace-nowrap">
                    {card.deletedAt ? <RelativeTime date={card.deletedAt} prefix="Trashed " /> : <RelativeTime date={card.updatedAt} prefix="Edited " />}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      ref={publishedCard.captureRestore}
                      type="button"
                      className="btn btn-sm btn-outline gap-1 whitespace-nowrap"
                      disabled={presentation.busy !== null}
                      onClick={(event) => publishRestore(card, event)}
                      data-testid="restore-button"
                    >
                      {card.busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                    </button>
                    <button
                      ref={publishedCard.capturePurge}
                      type="button"
                      className="btn btn-sm gap-1 whitespace-nowrap text-danger hover:bg-red-50 dark:hover:bg-red-950/40"
                      disabled={presentation.busy !== null}
                      onClick={(event) => publishPurge(card, event)}
                      data-testid="purge-button"
                    >
                      <Trash2 size={13} /> Delete forever
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
