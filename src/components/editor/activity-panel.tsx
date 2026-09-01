"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity as ActivityIcon, Bot, Loader2, X } from "lucide-react";
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
export function describeActivity(item: ActivityItemDto): string {
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

function groupByDay(items: ActivityItemDto[]): { day: string; items: ActivityItemDto[] }[] {
  const groups: { day: string; items: ActivityItemDto[] }[] = [];
  for (const item of items) {
    const key = new Date(item.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.day === key) last.items.push(item);
    else groups.push({ day: key, items: [item] });
  }
  return groups;
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

export function ActivityPanel({ session, onClose }: ActivityPanelProps) {
  const [items, setItems] = useState<ActivityItemDto[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expanded = useRef(false);

  // Reload the first page; older pages the user has already expanded are kept below it.
  const refresh = useCallback(async () => {
    try {
      const page = await api.documents.activity(session.docId, { limit: PAGE });
      setItems((prev) => {
        if (!prev || !expanded.current) return page.items;
        const seen = new Set(page.items.map((i) => i.id));
        return [...page.items, ...prev.filter((i) => !seen.has(i.id))];
      });
      if (!expanded.current) setNextBefore(page.nextBefore);
      setError(null);
      setNow(Date.now());
    } catch (e) {
      setError(apiErrorText(e, "Failed to load activity"));
    }
  }, [session.docId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.documents.activity(session.docId, { before: nextBefore, limit: PAGE });
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((i) => i.id));
        return [...(prev ?? []), ...page.items.filter((i) => !seen.has(i.id))];
      });
      setNextBefore(page.nextBefore);
      expanded.current = true;
    } catch (e) {
      setError(apiErrorText(e, "Failed to load more"));
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = useMemo(() => groupByDay(items ?? []), [items]);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="activity-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Activity</span>
        <button type="button" className="icon-btn h-8 w-8" onClick={onClose} aria-label="Close activity">
          <X size={16} />
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40">{error}</div>}
        {items === null ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<ActivityIcon size={28} />} title="No activity yet">
            Edits, comments, versions and shares by people and agents show up here.
          </EmptyState>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.day} className="mb-4">
                <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">{g.day}</div>
                <ul className="flex flex-col gap-1">
                  {g.items.map((item) => (
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
                          <span className="font-medium text-ink">{item.actorName}</span>
                          {item.actorKind === "agent" && (
                            <span className="rounded bg-violet-100 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700" data-testid="activity-agent-chip">
                              agent
                            </span>
                          )}
                          <span className="break-words">{describeActivity(item)}</span>
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
              <button type="button" className={cn("btn btn-sm btn-ghost w-full justify-center gap-1.5")} onClick={() => void loadMore()} disabled={loadingMore} data-testid="activity-load-more">
                {loadingMore && <Loader2 size={13} className="animate-spin" />}
                Load more
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
