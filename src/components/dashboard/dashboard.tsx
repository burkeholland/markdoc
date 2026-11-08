"use client";
import { Avatar, Dialog, DialogContent, DialogTrigger, Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, TooltipProvider } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";
import { ThemeToggle } from "@/components/ui/theme-toggle";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, CalendarCheck, ChevronDown, DraftingCompass, File, FilePlus2, FolderOpen, GitBranch, LayoutTemplate, ListChecks, Loader2, LogOut, MoreVertical, PenLine, RotateCcw, Scale, Search, Settings, FileText, Sparkles, Star, Trash2, Users, X } from "lucide-react";
import { api, apiErrorText, type DocumentSummaryDto, type SearchResultDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ui/relative-time";
import { takePendingNotice, type PendingNotice } from "@/lib/notice";
import { PICKER_TEMPLATES, TEMPLATES, WELCOME_TEMPLATE_ID, getTemplate, type Template, type TemplateIcon } from "@/lib/templates";
import { DEFAULT_DASHBOARD_SORT, SORT_COOKIE, SORT_COOKIE_MAX_AGE, SORT_OPTIONS, SORT_STORAGE_KEY, isDashboardSort, type DashboardSort } from "@/lib/dashboard-sort";

import { Logo } from "@/components/ui/logo";
import { GitHubPicker } from "@/components/editor/github-dialog";
import { isManagedGithubLogin } from "@/lib/github-login";
import { NotificationsStrip } from "@/components/dashboard/notifications-strip";
import { ImportDialog, ImportDropzone, shouldOpenImported, useFileImport } from "@/components/dashboard/import-dialog";
import {
  DOCUMENT_DRAG_TYPE,
  FolderRail,
  MoveToItems,
  SelectionBar,
  TOP_LEVEL,
  useFolders,
  type FolderSelection,
} from "@/components/dashboard/folders";
import { CommandPalette, isPaletteShortcut } from "@/components/editor/command-palette";
import { buildDashboardCommands } from "@/components/editor/commands";
import { signOutSafely } from "@/lib/sign-out";

type Doc = DocumentSummaryDto;
type SearchDoc = SearchResultDto;

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const DASHBOARD_SEARCH_STORAGE_KEY = "markdoc:dashboardSearch";
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

function dashboardSearchStorageKey(userId: string): string {
  return `${DASHBOARD_SEARCH_STORAGE_KEY}:${userId}`;
}

function readDashboardSearch(userId: string): string {
  try {
    return window.sessionStorage.getItem(dashboardSearchStorageKey(userId)) ?? "";
  } catch (error) {
    console.error("Could not restore dashboard search", error);
    return "";
  }
}

function writeDashboardSearch(userId: string, query: string) {
  try {
    const key = dashboardSearchStorageKey(userId);
    if (query) window.sessionStorage.setItem(key, query);
    else window.sessionStorage.removeItem(key);
  } catch (error) {
    console.error("Could not persist dashboard search", error);
  }
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


/** Grid of template cards; `busy` is the id currently being created (disables the grid). */
export function TemplateGrid({ onPick, busy, compact }: { onPick: (t: Template) => void; busy: string | null; compact?: boolean }) {
  return (
    <ul className={cn("grid gap-3", compact ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3")} data-testid="template-grid">
      {PICKER_TEMPLATES.map((t) => {
        const Icon = TEMPLATE_ICONS[t.icon];
        const isBusy = busy === t.id;
        return (
          <li key={t.id} className="min-w-0">
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

interface DeleteOperation {
  ownerId: string;
  documentId: string;
  title: string;
  focusRecovery: {
    nextDocumentId: string | null;
    previousDocumentId: string | null;
  } | null;
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

/** The busy key `create()` publishes for a blank document (no template). */
const CREATE_BLANK_KEY = "blank";
// The card is half width beside "Open from GitHub", so its layout follows the card's width, not the viewport's.
const CREATE_CARD_CLASS =
  "@container group flex flex-wrap items-stretch rounded-2xl border border-line bg-surface shadow-sm transition hover:border-accent hover:shadow-md";
const CREATE_BLANK_BUTTON_CLASS =
  "flex w-full items-center gap-4 rounded-t-2xl p-5 text-left @[32rem]:w-auto @[32rem]:flex-1 @[32rem]:rounded-none @[32rem]:rounded-l-2xl";
const CREATE_BLANK_ICON_FRAME_CLASS =
  "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent";
const CREATE_BLANK_NAME_CLASS = "block text-[15px] font-semibold text-ink";
const CREATE_BLANK_DESCRIPTION_CLASS = "block text-sm text-ink-3";
const CREATE_BLANK_NAME_TEXT = "New document";
const CREATE_BLANK_DESCRIPTION_TEXT = "Start with a blank Markdown page.";
const CREATE_GUIDED_ROOT_CLASS = "mb-5 text-center";
const CREATE_GUIDED_PRIMARY_CLASS = "text-sm font-medium text-ink-2";
const CREATE_GUIDED_SECONDARY_CLASS = "mt-1 text-sm text-ink-3";
const CREATE_GUIDED_PRIMARY_TEXT = "No documents yet";
const CREATE_GUIDED_SECONDARY_TEXT =
  "Start with a short guided document, pick a template, or open a Markdown file.";
const CREATE_WELCOME_BUTTON_CLASS = "btn btn-primary mt-4 gap-2";

interface NoticeAuthority {
  mount: symbol;
  userId: string;
}

interface NoticePublication {
  authority: NoticeAuthority;
  notice: PendingNotice;
  timer: ReturnType<typeof setTimeout> | null;
}

type FilterDefinition = { readonly value: Filter; readonly label: string };

const FILTERS = Object.freeze([
  Object.freeze({ value: "all", label: "All" }),
  Object.freeze({ value: "mine", label: "Owned by me" }),
  Object.freeze({ value: "shared", label: "Shared with me" }),
  Object.freeze({ value: "starred", label: "Starred" }),
  Object.freeze({ value: "trash", label: "Trash" }),
] as const satisfies readonly FilterDefinition[]);
const FILTER_GROUP_CLASS =
  "flex min-w-0 max-w-full flex-wrap rounded-lg border border-line bg-surface p-0.5 text-xs";
const FILTER_GROUP_LABEL = "Document filters";

function filterButtonClass(selected: boolean) {
  return cn(
    "tap-target relative min-h-11 min-w-11 rounded-md px-2.5 py-1 md:min-h-6 md:min-w-0",
    selected
      ? "bg-inverse text-white"
      : "text-ink-3 hover:text-ink",
  );
}

function filterDestination(
  key: string,
  current: number,
): number | null {
  if (current < 0 || current >= FILTERS.length) return null;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (current + 1) % FILTERS.length;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (current - 1 + FILTERS.length) % FILTERS.length;
  }
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") {
    return current === FILTERS.length - 1 ? null : FILTERS.length - 1;
  }
  return null;
}

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
        "tap-target flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-surface-3 focus-visible:opacity-100",
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
  const [accountOpen, setAccountOpen] = useState(false);
  // ArrowDown/ArrowUp on the closed account trigger open the menu on its first/last item.
  const accountFocusOnOpen = useRef<"first" | "last" | null>(null);
  const accountSettingsRef = useRef<HTMLDivElement>(null);
  const accountSignOutRef = useRef<HTMLDivElement>(null);
  const changeAccountOpen = useCallback((open: boolean) => {
    if (!open) accountFocusOnOpen.current = null;
    setAccountOpen(open);
  }, []);
  const openAccountSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);
  const signOutAccount = useCallback(() => {
    void signOutSafely();
  }, []);
  const [query, setQuery] = useState("");
  const updateSearch = useCallback((next: string) => {
    setQuery(next);
    writeDashboardSearch(user.id, next);
  }, [user.id]);
  const queryRestored = useRef(false);
  useLayoutEffect(() => {
    if (queryRestored.current) return;
    queryRestored.current = true;
    setQuery(readDashboardSearch(user.id));
  }, [user.id]);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchResultListRef = useRef<HTMLUListElement>(null);
  const documentsHeadingRef = useRef<HTMLHeadingElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(false);
  const [openPicker, setOpenPicker] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const filterRef = useRef<Filter>("all");
  const filterButtons = useRef(new Map<Filter, HTMLButtonElement>());
  const [searchMount] = useState(() => Symbol("dashboard-search"));
  const searchAuthority = useMemo<SearchAuthority>(
    () =>
      Object.freeze({
        mount: searchMount,
        visit: Symbol("dashboard-user-visit"),
        user,
        userId: user.id,
      }),
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
    if (enteringTrash) {
      trashVisitId.current += 1;
      updateSearch("");
    }
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
  }, [replaceTrashError, updateSearch]);

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

  const deleteOwner = useRef(user.id);
  const deleteOperations = useRef(new Map<string, DeleteOperation>());
  const deletePropsRef = useRef(initialDocuments);
  const [deleteBusyIds, setDeleteBusyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const deleteFocusRecovery = useRef<{ documentId: string; nextDocumentId: string | null; previousDocumentId: string | null } | null>(null);

  useLayoutEffect(() => {
    const previousOwner = deleteOwner.current;
    deleteOwner.current = user.id;
    if (previousOwner === user.id) return;
    deleteOperations.current.clear();
    setDeleteBusyIds(new Set());
    setDeletedIds(new Set());
  }, [user.id]);

  useLayoutEffect(
    () => () => {
      deleteOperations.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    const recovery = deleteFocusRecovery.current;
    if (!recovery || !deletedIds.has(recovery.documentId)) return;
    deleteFocusRecovery.current = null;

    const cards = Array.from(
      searchResultListRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-testid="document-card"]') ?? [],
    );
    const cardFor = (documentId: string | null) =>
      documentId ? cards.find((card) => card.getAttribute("href") === `/d/${documentId}`) ?? null : null;
    const destination = cardFor(recovery.nextDocumentId) ?? cardFor(recovery.previousDocumentId);
    if (destination) {
      destination.focus({ preventScroll: true });
    } else {
      documentsHeadingRef.current?.focus({ preventScroll: true });
    }
  }, [deletedIds]);

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
  /**
   * Folders a document has been moved to in this session, by document id. The page is server-rendered
   * with its documents, so a move has to show immediately here — the same shape `starStates` uses for
   * stars. Cleared when the server sends a fresh list (#2377).
   */
  const [folderOverrides, setFolderOverrides] = useState<Record<string, string | null>>({});
  const folderPropsRef = useRef(initialDocuments);
  useEffect(() => {
    if (folderPropsRef.current === initialDocuments) return;
    folderPropsRef.current = initialDocuments;
    setFolderOverrides({});
  }, [initialDocuments]);

  const documents = useMemo(
    () =>
      initialDocuments
        .filter((d) => !deletedIds.has(d.id))
        .map((d) => {
          const starred = starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d;
          return d.id in folderOverrides ? { ...starred, folderId: folderOverrides[d.id] } : starred;
        }),
    [initialDocuments, starStates, folderOverrides, deletedIds],
  );
  useEffect(() => {
    if (deletePropsRef.current === initialDocuments) return;
    deletePropsRef.current = initialDocuments;
    setDeletedIds((current) => {
      if (current.size === 0) return current;
      const present = new Set(initialDocuments.map((document) => document.id));
      const next = new Set([...current].filter((id) => present.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [initialDocuments]);
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
  const contentSearchLimited = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;

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
      !owner.input.disabled &&
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
  // runSearch sets searchRequestOwner synchronously, so a second click before the re-render sends nothing.
  const retrySearch = useCallback(() => {
    if (!currentSearchError || searchRequestOwner.current) return;
    runSearch(searchAuthority, currentSearchError.query);
  }, [currentSearchError, runSearch, searchAuthority]);

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
  const noticeFromFolders = useCallback(
    (message: string, kind: "error" | "info" = "info") => void publishNotice({ message, kind }),
    [publishNotice],
  );
  const folders = useFolders(noticeFromFolders);
  const folderSelection: FolderSelection = folders.selection;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [moving, setMoving] = useState(false);

  // Only a document the person owns can be filed: a folder belongs to one person, so there is nowhere
  // to put a document shared with them.
  const canFile = useCallback((doc: Doc) => doc.ownerId === user.id, [user.id]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const deleteDocument = useCallback(
    (doc: Doc) => {
      if (!canFile(doc) || deleteOperations.current.has(doc.id)) return;
      if (!confirm(`Move “${doc.title}” to trash? You can restore it from the dashboard for 30 days.`)) return;

      const cards = Array.from(
        searchResultListRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-testid="document-card"]') ?? [],
      );
      const cardIndex = cards.findIndex((card) => card.getAttribute("href") === `/d/${doc.id}`);
      const operation: DeleteOperation = {
        ownerId: user.id,
        documentId: doc.id,
        title: doc.title,
        focusRecovery:
          cardIndex < 0
            ? null
            : {
                nextDocumentId: cards[cardIndex + 1]?.getAttribute("href")?.slice("/d/".length) ?? null,
                previousDocumentId: cards[cardIndex - 1]?.getAttribute("href")?.slice("/d/".length) ?? null,
              },
      };
      deleteOperations.current.set(doc.id, operation);
      setDeleteBusyIds((current) => {
        const next = new Set(current);
        next.add(doc.id);
        return next;
      });
      const isCurrent = () =>
        deleteOwner.current === operation.ownerId &&
        deleteOperations.current.get(operation.documentId) === operation;

      void (async () => {
        try {
          await api.documents.delete(operation.documentId);
          if (!isCurrent()) return;
          deleteFocusRecovery.current =
            operation.focusRecovery && {
              documentId: operation.documentId,
              ...operation.focusRecovery,
            };
          setDeletedIds((current) => {
            if (current.has(operation.documentId)) return current;
            const next = new Set(current);
            next.add(operation.documentId);
            return next;
          });
          setSelectedIds((current) => {
            if (!current.has(operation.documentId)) return current;
            const next = new Set(current);
            next.delete(operation.documentId);
            return next;
          });
          publishNotice({ message: `“${operation.title}” was moved to the trash.`, kind: "success" });
          void folders.refresh();
          router.refresh();
        } catch (error) {
          if (isCurrent()) {
            publishNotice({ message: apiErrorText(error, "Could not move to trash"), kind: "error" });
          }
        } finally {
          if (deleteOperations.current.get(operation.documentId) !== operation) return;
          deleteOperations.current.delete(operation.documentId);
          setDeleteBusyIds((current) => {
            if (!current.has(operation.documentId)) return current;
            const next = new Set(current);
            next.delete(operation.documentId);
            return next;
          });
        }
      })();
    },
    [canFile, folders, publishNotice, router, user.id],
  );

  const filtered = useMemo<(Doc & { snippet?: string | null })[]>(() => {
    const matchesFilter = (d: Doc) => {
      if (filter === "mine" && d.ownerId !== user.id) return false;
      if (filter === "shared" && d.ownerId === user.id) return false;
      if (filter === "starred" && !d.starred) return false;
      // A folder selection narrows the list the same way a chip does. "All documents" (`null`) keeps
      // everything; `TOP_LEVEL` keeps documents whose folder is not visible to this person.
      if (folderSelection === TOP_LEVEL && d.folderId !== null) return false;
      if (typeof folderSelection === "string" && d.folderId !== folderSelection) return false;
      return true;
    };
    // Search results keep their relevance order (title matches first); the sort applies to the browsing list.
    if (serverResults) {
      return serverResults
        .filter((d) => !deletedIds.has(d.id))
        .map((d) => (starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d))
        .filter(matchesFilter);
    }
    const q = trimmed.toLowerCase();
    return documents.filter((d) => matchesFilter(d) && (!q || d.title.toLowerCase().includes(q))).sort(compareDocs(sort));
  }, [documents, serverResults, trimmed, filter, sort, user.id, starStates, folderSelection, deletedIds]);
  const searchAnnouncement =
    filter === "trash" || !trimmed
      ? ""
      : contentSearchLimited
        ? filtered.length === 0
          ? `No title matches for "${trimmed}". Content search starts at ${MIN_QUERY_LENGTH} characters.`
          : `${filtered.length} title ${filtered.length === 1 ? "match" : "matches"} for "${trimmed}". Content search starts at ${MIN_QUERY_LENGTH} characters.`
        : pending
        ? "Searching documents…"
        : currentSearchError
          ? filtered.length === 0
            ? `No title matches for "${trimmed}".`
            : `${filtered.length} title ${filtered.length === 1 ? "match" : "matches"} for "${trimmed}".`
          : filtered.length === 0
            ? `No results for "${trimmed}".`
            : `${filtered.length} result${filtered.length === 1 ? "" : "s"} for "${trimmed}".`;

  const starred = useMemo(() => documents.filter((d) => d.starred).sort(compareDocs(sort)), [documents, sort]);
  const showStrip = filter === "all" && !trimmed && starred.length > 0;

  /**
   * File documents under a folder (or back to the top level for `null`). The server answers with the
   * ids it actually moved, so a document that was trashed or un-owned in between is simply left alone
   * rather than shown in the wrong place.
   */
  const moveDocuments = useCallback(
    async (documentIds: readonly string[], folderId: string | null) => {
      if (documentIds.length === 0 || moving) return;
      setMoving(true);
      try {
        const { moved } = await api.documents.move(documentIds, folderId);
        setFolderOverrides((current) => {
          const next = { ...current };
          for (const id of moved) next[id] = folderId;
          return next;
        });
        clearSelection();
        // The chip counts live on the server; refresh them rather than guessing the arithmetic.
        void folders.refresh();
        if (moved.length > 0) {
          const count = `${moved.length} document${moved.length === 1 ? "" : "s"}`;
          // "to Not in a folder" reads as a mistake, so the top level gets its own wording.
          const message = folderId
            ? `Moved ${count} to ${folders.folders.find((f) => f.id === folderId)?.name ?? "the folder"}`
            : `Moved ${count} out of the folder`;
          publishNotice({ message, kind: "info" });
        }
      } catch (err) {
        publishNotice({ message: apiErrorText(err, "Could not move the document"), kind: "error" });
      } finally {
        setMoving(false);
      }
    },
    [moving, clearSelection, folders, publishNotice],
  );

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
        // Stay busy after a success: router.push() returns before the document page replaces the
        // dashboard, and a second click in that gap would create a second document. Unmount clears it.
        router.push(`/d/${res.document.id}`);
      } catch (err) {
        if (!isCurrent()) return;
        createOperation.current = null;
        setCreateBusyOperation((current) => (current === operation ? null : current));
        console.error(err);
        publishNotice({ message: apiErrorText(err, "Could not create the document"), kind: "error" });
      }
    },
    [publishNotice, router, user.id],
  );

  // Command palette (Mod-Shift-P, or Mod-K outside the search box), scoped to dashboard actions.
  // Local files dropped on the page or picked with "Open file…": one file without warnings opens
  // straight away; several stay listed in the dialog while the list behind it refreshes — as does a
  // batch with a failure in it, or one file with warnings (a refused image), so they stay visible.
  const fileImport = useFileImport({
    onDone: (created, failed) => {
      if (shouldOpenImported(created, failed)) router.push(`/d/${created[0].id}`);
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
  const changeSearch = (event: ReactChangeEvent<HTMLInputElement>) => {
    updateSearch(event.target.value);
  };
  const clearSearch = () => {
    updateSearch("");
    searchRef.current?.focus();
  };
  // Escape clears the box, then leaves it. ArrowDown/ArrowUp move from the box to the first/last search result.
  const keyDownSearch = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.repeat || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) updateSearch("");
      else event.currentTarget.blur();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !trimmed) return;
    const links = Array.from(searchResultListRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-testid="document-card"]') ?? []);
    const destination = event.key === "ArrowDown" ? links[0] : links.at(-1);
    if (!destination) return;
    event.preventDefault();
    destination.focus({ preventScroll: true });
  };
  const showCreateEmptyState =
    filter === "all" &&
    folderSelection === null &&
    filtered.length === 0 &&
    !trimmed &&
    documents.length === 0;
  const selectedFolderIsEmpty =
    typeof folderSelection === "string" &&
    folders.folders.some((folder) => folder.id === folderSelection && folder.documentCount === 0);
  const selectedFolderFilterEmptyState = (() => {
    if (folderSelection === null || filter === "all" || filter === "trash") return null;
    if (folderSelection === TOP_LEVEL && filter === "mine") {
      return {
        title: "No unfiled documents owned by you",
        description: "Choose All documents to see your filed documents.",
      };
    }
    if (folderSelection === TOP_LEVEL && filter === "shared") return null;
    if (folderSelection === TOP_LEVEL) {
      return {
        title: "No matching unfiled documents",
        description: "Choose All documents or another folder to see more.",
      };
    }
    if (filter === "shared") {
      return {
        title: "Shared documents aren't filed in folders",
        description: "Choose All documents to see documents shared with you.",
      };
    }
    return {
      title: "No matching documents in this folder",
      description: "Choose All documents or another folder to see more.",
    };
  })();
  const emptyStateTitle =
    pending
      ? `Searching for "${trimmed}"…`
      : currentSearchError
        ? `No title matches for "${trimmed}"`
        : trimmed
          ? `${contentSearchLimited ? "No title matches" : "No matches"} for "${trimmed}"`
          : selectedFolderIsEmpty
            ? "This folder is empty"
            : selectedFolderFilterEmptyState
              ? selectedFolderFilterEmptyState.title
              : filter === "shared"
                ? "Nothing has been shared with you yet"
                : filter === "starred"
                  ? "No starred documents"
                  : filter === "mine"
                    ? "No documents owned by you yet"
                    : folderSelection === TOP_LEVEL
                      ? "No unfiled documents"
                      : "No documents to show";
  const emptyStateDescription =
    pending
      ? "Looking through titles and content."
      : currentSearchError
        ? "Content results are unavailable. Retry the search above."
        : trimmed
          ? contentSearchLimited
            ? `Content search starts at ${MIN_QUERY_LENGTH} characters.`
            : "Try a different search."
          : selectedFolderIsEmpty
            ? "Create a document above, then move it here from its card menu, or drag an existing card onto this folder."
            : selectedFolderFilterEmptyState
              ? selectedFolderFilterEmptyState.description
              : filter === "shared"
                ? "Documents shared with you will appear here."
                : filter === "starred"
                  ? "Star a document from its card or editor header to keep it here."
                  : filter === "mine"
                    ? "Documents you own will appear here."
                    : folderSelection === TOP_LEVEL
                      ? "Move documents here from a card menu, or choose All documents to see everything."
                      : "Choose another filter to see more documents.";
  const welcomeTemplate = getTemplate(WELCOME_TEMPLATE_ID);
  // Arrow keys move between filters (wrapping) and select the one they land on; Home and End jump to the ends.
  const keyDownFilter = (value: Filter, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const index = FILTERS.findIndex((f) => f.value === value);
    const destination = filterDestination(event.key, index);
    if (destination === null) return;
    event.preventDefault();
    const next = FILTERS[destination]!.value;
    changeFilter(next);
    filterButtons.current.get(next)?.focus({ preventScroll: true });
  };
  const keyDownAccountTrigger = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (accountOpen || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    accountFocusOnOpen.current = event.key === "ArrowDown" ? "first" : "last";
    changeAccountOpen(true);
  };
  const openAccountAutoFocus = (event: Event) => {
    const direction = accountFocusOnOpen.current;
    accountFocusOnOpen.current = null;
    const destination = direction === "first" ? accountSettingsRef.current : direction === "last" ? accountSignOutRef.current : null;
    if (!destination) return;
    event.preventDefault();
    destination.focus({ preventScroll: true });
  };

  return (
    <TooltipProvider>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} groupOrder={DASHBOARD_GROUPS} />
      <ImportDropzone active={fileImport.dragging} />
      {fileImport.input}
      <ImportDialog open={fileImport.open} onOpenChange={fileImport.setOpen} items={fileImport.items} ignored={fileImport.ignored} />
      <main className="min-h-screen bg-surface-2">
        <h1 className="sr-only">Documents</h1>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="search-status">
          {searchAnnouncement}
        </div>
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
                placeholder={filter === "trash" ? "Search unavailable in Trash" : "Search documents"}
                aria-label={filter === "trash" ? "Search unavailable in Trash" : "Search documents"}
                value={query}
                onChange={changeSearch}
                onKeyDown={keyDownSearch}
                disabled={filter === "trash"}
                data-testid="search"
              />
              {filter !== "trash" && !query && (
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
            <Menu open={accountOpen} onOpenChange={changeAccountOpen}>
              <MenuTrigger asChild>
                <button type="button" className="rounded-full" aria-label="Account" onKeyDown={keyDownAccountTrigger}>
                  <Avatar name={user.name} src={user.image} size={36} alt="" />
                </button>
              </MenuTrigger>
              {/* Radix forwards onOpenAutoFocus to its focus scope but omits it from the dropdown's prop types. */}
              <MenuContent align="end" className="w-56" {...{ onOpenAutoFocus: openAccountAutoFocus }}>
                <div className="px-2.5 py-2">
                  <div className="truncate text-sm font-medium text-ink" title={user.name}>{user.name}</div>
                  {user.login && <div className="truncate text-xs text-ink-3" title={`@${user.login}`}>@{user.login}</div>}
                </div>
                <MenuItem ref={accountSettingsRef} icon={<Settings size={15} />} onSelect={openAccountSettings}>
                  Settings
                </MenuItem>
                <MenuItem ref={accountSignOutRef} icon={<LogOut size={15} />} onSelect={signOutAccount}>
                  Sign out
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>

        <section className="safe-x mx-auto max-w-6xl py-6 sm:py-8 sm:[--safe-pad:1.5rem]">
          <NotificationsStrip />
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            <div className={cn(CREATE_CARD_CLASS, !githubConfigured && "sm:col-span-2")}>
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating !== null}
                className={CREATE_BLANK_BUTTON_CLASS}
                data-testid="new-document"
              >
                <span className={CREATE_BLANK_ICON_FRAME_CLASS}>{creating === CREATE_BLANK_KEY ? <Loader2 className="animate-spin" /> : <FilePlus2 size={22} />}</span>
                <span>
                  <span className={CREATE_BLANK_NAME_CLASS}>{CREATE_BLANK_NAME_TEXT}</span>
                  <span className={CREATE_BLANK_DESCRIPTION_CLASS}>{CREATE_BLANK_DESCRIPTION_TEXT}</span>
                </span>
              </button>
              <Dialog open={openTemplates} onOpenChange={(open) => !creating && setOpenTemplates(open)}>
                <DialogTrigger asChild>
                  <button
                    type="button"
                    disabled={creating !== null}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-bl-2xl border-r border-t border-line px-3 text-sm text-ink-3 transition hover:bg-surface-2 hover:text-ink @[32rem]:flex-none @[32rem]:rounded-none @[32rem]:border-l @[32rem]:border-r-0 @[32rem]:border-t-0 @[32rem]:px-4"
                    aria-label="New document from template"
                    title="From template"
                    data-testid="new-from-template"
                  >
                    <LayoutTemplate size={16} />
                    <span>From template</span>
                    <ChevronDown size={14} className="@max-[21rem]:hidden" />
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
                className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-br-2xl border-t border-line px-3 text-sm text-ink-3 transition hover:bg-surface-2 hover:text-ink @[32rem]:flex-none @[32rem]:rounded-none @[32rem]:rounded-r-2xl @[32rem]:border-l @[32rem]:border-t-0 @[32rem]:px-4"
                aria-label="Open file…"
                title="Open file… (.md, .txt, .html)"
                data-testid="open-file"
              >
                <FolderOpen size={16} />
                <span>Open file</span>
              </button>
            </div>
            {githubConfigured && (
              <button
                type="button"
                onClick={() => setOpenPicker(true)}
                className="group flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition hover:border-accent hover:shadow-md"
                data-testid="open-github"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-inverse text-white">
                  <GitHubIcon size={22} />
                </span>
                <span>
                  <span className="block text-[15px] font-semibold text-ink">Open from GitHub</span>
                  <span className="block text-sm text-ink-3">Edit a Markdown file from a gist or repository.</span>
                </span>
              </button>
            )}
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
                    onClick={() => changeFilter("starred")}
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

          {/* Folders organize what a person owns, so the rail is out of the way in the trash and while
              searching, where the list is not a folder's contents. */}
          {filter !== "trash" && !trimmed && (
            <FolderRail
              state={folders}
              totalCount={documents.length}
              unfiledCount={documents.filter((d) => canFile(d) && d.folderId === null).length}
              onDropDocuments={moveDocuments}
            />
          )}

          {selectedIds.size > 0 && filter !== "trash" && (
            <SelectionBar
              count={selectedIds.size}
              folders={folders.folders}
              busy={moving}
              onClear={clearSelection}
              onMove={(folderId) => void moveDocuments([...selectedIds], folderId)}
            />
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 ref={documentsHeadingRef} tabIndex={-1} className="text-sm font-semibold text-ink">Documents</h2>
            <div className="ml-auto flex min-h-8 min-w-0 max-w-full flex-wrap items-center gap-2 max-sm:basis-full" data-testid="dashboard-chips">
              <label className="flex items-center gap-1.5 text-xs text-ink-3">
                <span className="sr-only">Sort by</span>
                <select
                  className="h-7 rounded-lg border border-line bg-surface px-2 text-xs text-ink-2 focus-visible:border-accent"
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
              <div className={FILTER_GROUP_CLASS} role="toolbar" aria-label={FILTER_GROUP_LABEL}>
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    ref={(element) => {
                      if (element) filterButtons.current.set(f.value, element);
                      else filterButtons.current.delete(f.value);
                    }}
                    type="button"
                    className={filterButtonClass(filter === f.value)}
                    onClick={() => changeFilter(f.value)}
                    onKeyDown={(event) => keyDownFilter(f.value, event)}
                    tabIndex={filter === f.value ? 0 : -1}
                    aria-pressed={filter === f.value}
                    data-testid={`filter-${f.value}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filter !== "trash" && contentSearchLimited && filtered.length > 0 && (
            <p className="mb-3 text-xs text-ink-3" data-testid="search-content-hint">
              Content search starts at {MIN_QUERY_LENGTH} characters.
            </p>
          )}

          {currentSearchError && (
            <div
              className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
              role="alert"
              aria-atomic="true"
              data-testid="search-error"
            >
              <span className="min-w-0 flex-1 wrap-anywhere">
                Content search failed: {currentSearchError.message}. Showing title matches only.
              </span>
              <button
                type="button"
                className="btn btn-sm btn-outline shrink-0"
                onClick={retrySearch}
                disabled={searching}
                aria-busy={searching || undefined}
              >
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
          ) : showCreateEmptyState ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-8" data-testid="empty-state">
              <div className={CREATE_GUIDED_ROOT_CLASS}>
                <FileText className="mx-auto mb-3 text-ink-4" size={28} />
                <p className={CREATE_GUIDED_PRIMARY_CLASS}>{CREATE_GUIDED_PRIMARY_TEXT}</p>
                <p className={CREATE_GUIDED_SECONDARY_CLASS}>{CREATE_GUIDED_SECONDARY_TEXT}</p>
                <button
                  type="button"
                  className={CREATE_WELCOME_BUTTON_CLASS}
                  onClick={() => void create(welcomeTemplate)}
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
                {emptyStateTitle}
              </p>
              <p className="mt-1 text-sm text-ink-3">
                {emptyStateDescription}
              </p>
              {trimmed && !pending && (
                <button
                  type="button"
                  className="mt-3 text-sm font-medium text-accent hover:underline"
                  onClick={clearSearch}
                  data-testid="empty-state-clear-search"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <ul ref={searchResultListRef} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="document-list">
              {filtered.map((d) => (
                <li
                  key={d.id}
                  className="group relative min-w-0"
                  data-testid={trimmed ? "search-result" : undefined}
                  // Dragging a selected card takes the whole selection; dragging an unselected one takes
                  // just it, so a drag never silently moves documents the person forgot were ticked.
                  draggable={canFile(d)}
                  onDragStart={(event) => {
                    if (!canFile(d)) return;
                    const ids = selectedIds.has(d.id) ? [...selectedIds] : [d.id];
                    event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, JSON.stringify(ids));
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  data-selected={selectedIds.has(d.id) || undefined}
                >
                  <Link
                    href={`/d/${d.id}`}
                    className={cn(
                      "flex h-full flex-col rounded-2xl border bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md",
                      selectedIds.has(d.id) ? "border-accent ring-1 ring-accent" : "border-line",
                    )}
                    data-testid="document-card"
                  >
                    {/* `pr-8` on an own-document card keeps the storage badge clear of the ⋮ menu. */}
                    <div className={cn("mb-2 flex items-start justify-between gap-2", canFile(d) && "pr-8")}>
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
                    {/* Room for the star, plus the select box beside it on an own-document card. */}
                    <div className={cn("mt-3 flex items-center gap-2 text-xs text-ink-4", canFile(d) ? "pr-16" : "pr-8")}>
                      <span>{sort === "recent" && d.lastOpenedAt ? <RelativeTime date={d.lastOpenedAt} prefix="Opened " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                      {d.ownerId !== user.id && (
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} /> {d.ownerName ?? d.ownerLogin} · {d.role}
                        </span>
                      )}
                    </div>
                  </Link>
                  <StarButton starred={d.starred} pending={starStates[d.id]?.pending ?? false} onToggle={() => toggleStar(d)} className="absolute bottom-3 right-3" />
                  {canFile(d) && (
                    <>
                      {/* A real checkbox, so the card is selectable from the keyboard and screen readers
                          read its state. Shown once anything is selected, on hover, or on focus. */}
                      <label
                        className={cn(
                          "tap-target document-selection-target absolute bottom-3 right-10 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition",
                          "focus-within:opacity-100 group-hover:opacity-100",
                          selectedIds.has(d.id) ? "opacity-100" : "opacity-0",
                        )}
                      >
                        <span className="sr-only">Select {d.title}</span>
                        <input
                          type="checkbox"
                          className="m-0 h-6 w-6 cursor-pointer accent-[var(--accent)]"
                          checked={selectedIds.has(d.id)}
                          onChange={() => toggleSelected(d.id)}
                          data-testid="select-document"
                          data-document-id={d.id}
                        />
                      </label>
                      <Menu>
                        <MenuTrigger asChild>
                          <button
                            type="button"
                            className="tap-target absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 opacity-0 transition hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                            aria-label={`Actions for ${d.title}`}
                            data-testid="document-menu"
                            data-document-id={d.id}
                          >
                            <MoreVertical size={15} />
                          </button>
                        </MenuTrigger>
                        <MenuContent className="w-52">
                          <MoveToItems
                            folders={folders.folders}
                            currentFolderId={d.folderId}
                            onMove={(folderId) => void moveDocuments([d.id], folderId)}
                          />
                          <MenuSeparator />
                          <MenuItem
                            icon={deleteBusyIds.has(d.id) ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                            className="text-danger"
                            onSelect={() => deleteDocument(d)}
                            disabled={deleteBusyIds.has(d.id)}
                            aria-busy={deleteBusyIds.has(d.id) || undefined}
                            data-testid="document-delete"
                          >
                            {deleteBusyIds.has(d.id) ? "Moving to trash…" : "Move to trash"}
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <Dialog open={openPicker} onOpenChange={setOpenPicker}>
          <DialogContent title="Open from GitHub" description="Pick a Markdown file. Markdoc keeps a live copy and publishes back when you ask it to." wide>
            <GitHubPicker mode="import" githubAvailable={githubAvailable} githubConfigured={githubConfigured} managedAccount={isManagedGithubLogin(user.login)} onImported={(id) => router.push(`/d/${id}`)} />
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

const allowTrashRetry = () => true;
const allowTrashAction = () => true;

const TRASH_NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]);

/** Arrow keys, Home and End move focus between a trash card's enabled actions, without wrapping. */
function moveTrashCardFocus(event: ReactKeyboardEvent<HTMLLIElement>) {
  if (!TRASH_NAVIGATION_KEYS.has(event.key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
  const actions = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")).filter((button) => !button.disabled);
  const source = actions.indexOf(event.target as HTMLButtonElement);
  if (source < 0) return;
  const destination =
    event.key === "ArrowLeft" || event.key === "ArrowUp"
      ? source - 1
      : event.key === "ArrowRight" || event.key === "ArrowDown"
        ? source + 1
        : event.key === "Home"
          ? 0
          : actions.length - 1;
  const target = actions[destination];
  if (!target || destination === source) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
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
  const retry = () => {
    if (error && !loading && canRetry(error)) onRetry();
  };
  const act = (kind: TrashActionKind, document: Doc) => {
    if (busy !== null || !canAct(document, kind)) return;
    if (kind === "restore") onRestore(document);
    else onPurge(document);
  };

  return (
    <div data-testid="trash-view" aria-busy={loading || undefined}>
      <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-3" data-testid="trash-note">
        <Trash2 size={12} /> Items are deleted forever after {TRASH_RETENTION_DAYS} days.
      </p>
      {error && (
        <div
          className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          role="alert"
          aria-atomic="true"
          data-testid="trash-error"
        >
          <span className="min-w-0 flex-1 wrap-anywhere">{error}</span>
          <button
            type="button"
            className="btn btn-sm btn-outline shrink-0 gap-1.5"
            onClick={retry}
            disabled={loading}
            aria-busy={loading || undefined}
          >
            {loading && <Loader2 size={13} className="animate-spin" />}
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {documents === null && !error ? (
        <div className="flex items-center gap-2 py-10 text-sm text-ink-3">
          <Loader2 size={16} className="animate-spin" /> Loading trash…
        </div>
      ) : documents?.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
          <Trash2 className="mx-auto mb-3 text-ink-4" size={28} />
          <p className="text-sm font-medium text-ink-2">The trash is empty</p>
          <p className="mt-1 text-sm text-ink-3">Documents you move to the trash can be restored here for {TRASH_RETENTION_DAYS} days.</p>
        </div>
      ) : documents ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="trash-list">
          {documents.map((d) => {
            const cardBusy = busy === d.id;
            return (
              <li
                key={d.id}
                className="flex h-full min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm"
                data-testid="trash-card"
                aria-busy={cardBusy || undefined}
                onKeyDown={moveTrashCardFocus}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink">{d.title}</h3>
                  <StorageBadge doc={d} />
                </div>
                <p className="line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-3">{d.excerpt || "Empty document"}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-4">
                  <span className="whitespace-nowrap">
                    {d.deletedAt ? <RelativeTime date={d.deletedAt} prefix="Trashed " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline gap-1 whitespace-nowrap"
                      disabled={busy !== null}
                      onClick={() => act("restore", d)}
                      data-testid="restore-button"
                    >
                      {cardBusy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm gap-1 whitespace-nowrap text-danger hover:bg-red-50 dark:hover:bg-red-950/40"
                      disabled={busy !== null}
                      onClick={() => act("purge", d)}
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
