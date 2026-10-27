"use client";

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Activity as ActivityIcon,
  Bot,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api, apiErrorText, type ActivityItemDto } from "@/lib/api";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { Avatar, EmptyState, Spinner } from "@/components/ui/primitives";

export interface ActivityPanelProps {
  session: CollabSession;
  onClose: () => void;
}

const REFRESH_MS = 30_000;
const PAGE = 50;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One human sentence per row, without the actor (rendered separately). */
export function describeActivity(item: Readonly<ActivityItemDto>): string {
  const d = item.detail ?? {};
  switch (item.action) {
    case "edit": {
      const chars = num(d.chars);
      return chars && chars > 0 ? `edited the document (~${chars.toLocaleString("en-US")} characters)` : "edited the document";
    }
    case "comment.add": {
      const quote = str(d.quote);
      return quote ? `commented: “${quote}”` : "commented";
    }
    case "comment.reply": {
      const quote = str(d.quote);
      return quote ? `replied: “${quote}”` : "replied to a comment";
    }
    case "comment.resolve": {
      const quote = str(d.quote);
      return quote ? `resolved a comment: “${quote}”` : "resolved a comment";
    }
    case "suggestion.add": {
      const n = num(d.count) ?? 1;
      return `suggested ${plural(n, "change")}`;
    }
    case "suggestion.accept": {
      const n = num(d.count) ?? 1;
      return `accepted ${plural(n, "suggestion")}`;
    }
    case "suggestion.reject": {
      const n = num(d.count) ?? 1;
      return `rejected ${plural(n, "suggestion")}`;
    }
    case "version.save": {
      const n = num(d.number);
      const title = str(d.title);
      return `saved version${n ? ` ${n}` : ""}${title ? ` ‘${title}’` : ""}`;
    }
    case "version.restore": {
      const n = num(d.number);
      const title = str(d.title);
      return `restored version${n ? ` ${n}` : ""}${title ? ` ‘${title}’` : ""}`;
    }
    case "publish": {
      const storage = str(d.storage);
      return storage === "gist" ? "published to the gist" : storage === "repo" ? "committed to GitHub" : "published";
    }
    case "share.add": {
      const login = str(d.login);
      const role = str(d.role);
      return `shared with ${login ? `@${login}` : "someone"}${role ? ` as ${role}` : ""}`;
    }
    case "share.remove": {
      const login = str(d.login);
      return `removed ${login ? `@${login}` : "a collaborator"}`;
    }
    case "asset.upload": {
      const name = str(d.name);
      return name ? `uploaded ${name}` : "uploaded an image";
    }
    case "title.change": {
      const title = str(d.title);
      return title ? `renamed the document to “${title}”` : "renamed the document";
    }
    case "agent.request": {
      const instruction = str(d.instruction);
      return instruction ? `asked an agent: “${instruction}”` : "asked an agent for help";
    }
    case "agent.request.done": {
      const parts: string[] = [];
      const s = num(d.suggestions);
      const c = num(d.comments);
      if (s) parts.push(plural(s, "suggestion"));
      if (c) parts.push(plural(c, "comment"));
      const summary = str(d.summary);
      return `finished a request${parts.length ? ` (${parts.join(", ")})` : ""}${summary ? `: “${summary}”` : ""}`;
    }
    default:
      return String(item.action);
  }
}

function groupByDay(items: readonly ActivityItemDto[]): { day: string; rows: ActivityItemDto[] }[] {
  const groups: { day: string; rows: ActivityItemDto[] }[] = [];
  for (const item of items) {
    const key = new Date(item.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.day === key) last.rows.push(item);
    else groups.push({ day: key, rows: [item] });
  }
  return groups;
}

const HEADER_NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]);

/** Arrow / Home / End move focus between the header's enabled buttons, without wrapping. */
function navigateHeader(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!HEADER_NAVIGATION_KEYS.has(event.key) || event.repeat || event.nativeEvent.isComposing || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")).filter((b) => !b.disabled);
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const next =
    event.key === "Home" ? 0
    : event.key === "End" ? buttons.length - 1
    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? index - 1
    : index + 1;
  if (next < 0 || next >= buttons.length || next === index) return;
  event.preventDefault();
  buttons[next]!.focus({ preventScroll: true });
}

function ActorAvatar({ item }: { item: ActivityItemDto }) {
  if (item.actorKind === "agent") {
    return (
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700" title={`${item.actorName} (agent)`}>
        <Bot size={15} />
      </span>
    );
  }
  return <Avatar name={item.actorName} size={28} />;
}

export function ActivityPanel(props: ActivityPanelProps) {
  return <ActivityPanelForDocument key={props.session.docId} {...props} />;
}
function ActivityPanelForDocument({ session, onClose }: ActivityPanelProps) {
  const documentId = session.docId;
  const [items, setItems] = useState<ActivityItemDto[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // In-flight guards and stale-response tokens; a new `visit` (effect run) invalidates late responses.
  const visit = useRef<object | null>(null);
  const refreshInFlight = useRef(false);
  const loadMoreToken = useRef<object | null>(null);
  const expanded = useRef(false);
  const cursor = useRef<string | null>(null);
  const cadence = useRef<ReturnType<typeof setInterval> | null>(null);

  const retire = useCallback(() => {
    if (cadence.current) clearInterval(cadence.current);
    cadence.current = null;
    visit.current = null;
    refreshInFlight.current = false;
    loadMoreToken.current = null;
  }, []);

  // Reload the first page; older pages the user has already expanded are kept below it.
  const refresh = useCallback((isRetry = false) => {
    const owner = visit.current;
    if (!owner || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    if (isRetry) setRetrying(true);
    void (async () => {
      try {
        const page = await api.documents.activity(documentId, { limit: PAGE });
        if (visit.current !== owner) return;
        setItems((prev) => {
          if (!prev || !expanded.current) return page.items;
          const seen = new Set(page.items.map((i) => i.id));
          return [...page.items, ...prev.filter((i) => !seen.has(i.id))];
        });
        if (!expanded.current) {
          if (loadMoreToken.current && cursor.current !== page.nextBefore) {
            loadMoreToken.current = null;
            setLoadingMore(false);
          }
          cursor.current = page.nextBefore;
          setNextBefore(page.nextBefore);
        }
        setListError(null);
        setNow(Date.now());
      } catch (e) {
        if (visit.current !== owner) return;
        setListError(apiErrorText(e, "Failed to load activity"));
      } finally {
        if (visit.current === owner) {
          refreshInFlight.current = false;
          setRefreshing(false);
          if (isRetry) setRetrying(false);
        }
      }
    })();
  }, [documentId]);

  const loadMore = useCallback(() => {
    const before = cursor.current;
    if (!visit.current || !before || loadMoreToken.current) return;
    const token = {};
    loadMoreToken.current = token;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await api.documents.activity(documentId, { before, limit: PAGE });
        if (loadMoreToken.current !== token) return;
        setItems((prev) => {
          const seen = new Set((prev ?? []).map((i) => i.id));
          return [...(prev ?? []), ...page.items.filter((i) => !seen.has(i.id))];
        });
        cursor.current = page.nextBefore;
        setNextBefore(page.nextBefore);
        expanded.current = true;
        setError(null);
      } catch (e) {
        if (loadMoreToken.current !== token) return;
        setError(apiErrorText(e, "Failed to load more"));
      } finally {
        if (loadMoreToken.current === token) {
          loadMoreToken.current = null;
          setLoadingMore(false);
        }
      }
    })();
  }, [documentId]);

  // Layout-timed so removal or document replacement retires pending work before late settlements.
  useLayoutEffect(() => {
    visit.current = {};
    refresh();
    cadence.current = setInterval(() => refresh(), REFRESH_MS);
    return retire;
  }, [refresh, retire]);

  const close = () => {
    if (!visit.current) return;
    retire();
    onClose();
  };

  const refreshAvailable = items !== null || listError !== null;
  const contentMode = items === null ? (listError ? "none" : "loading") : items.length === 0 ? "empty" : "list";
  const groups = groupByDay(items ?? []);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="activity-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2" onKeyDown={navigateHeader}>
        <span className="pane-label">Activity</span>
        {refreshAvailable && (
          <button
           
            type="button"
            className="icon-btn ml-auto h-8 w-8"
            onClick={() => refresh()}
            disabled={refreshing}
            aria-label={
              refreshing
                ? "Refreshing activity"
                : "Refresh activity"
            }
          >
            <RefreshCw
              size={15}
              className={cn(refreshing && "animate-spin")}
            />
          </button>
        )}
        <button type="button" className="icon-btn h-8 w-8" onClick={close} aria-label="Close activity">
          <X size={16} />
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        <div>
          {listError && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
              <div className="wrap-anywhere">{listError}</div>
              <button type="button" className="btn btn-outline btn-sm mt-2 gap-1.5" onClick={() => refresh(true)} disabled={retrying || refreshing}>
                {retrying && <Loader2 size={13} className="animate-spin" />}
                {retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40 wrap-anywhere">{error}</div>}
          {contentMode === "loading" ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : contentMode === "empty" ? (
            <EmptyState icon={<ActivityIcon size={28} />} title="No activity yet">
              Edits, comments, versions and shares by people and agents show up here.
            </EmptyState>
          ) : contentMode === "list" ? (
            <>
              {groups.map((group) => (
                <div key={group.day} className="mb-4">
                  <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">{group.day}</div>
                  <ul className="flex flex-col gap-1">
                    {group.rows.map((item) => (
                      <li
                       
                        key={item.id}
                        className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-surface"
                        data-testid="activity-row"
                        data-action={item.action}
                        data-actor-kind={item.actorKind}
                      >
                        <ActorAvatar item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] leading-5 text-ink-2">
                            <span className="wrap-anywhere font-medium text-ink">{item.actorName}</span>
                            {item.actorKind === "agent" && (
                              <span className="rounded bg-violet-100 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700" data-testid="activity-agent-chip">
                                agent
                              </span>
                            )}
                            <span className="wrap-anywhere">{describeActivity(item)}</span>
                          </div>
                          <div className="mt-0.5 text-xs text-ink-3">
                            <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>
                              {relativeTime(item.createdAt, now)}
                            </time>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {nextBefore && (
                <button type="button" className={cn("btn btn-sm btn-ghost w-full justify-center gap-1.5")} onClick={loadMore} disabled={loadingMore} data-testid="activity-load-more">
                  {loadingMore && <Loader2 size={13} className="animate-spin" />}
                  Load more
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
