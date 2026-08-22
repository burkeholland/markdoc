"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AtSign, X } from "lucide-react";
import { api, type MentionDto } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

/**
 * Unread @mentions of the current user, shown at the top of the dashboard.
 * Self-contained: fetches on mount and renders nothing when there is nothing to show.
 * Clicking a mention marks it read and opens the document.
 */
export function MentionsStrip() {
  const router = useRouter();
  const [mentions, setMentions] = useState<MentionDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.mentions
      .list()
      .then((res) => {
        if (!cancelled) setMentions(res.mentions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (mentions.length === 0) return null;

  const dismiss = async (m: MentionDto) => {
    setMentions((list) => list.filter((x) => x.id !== m.id));
    try {
      await api.mentions.read(m.id);
    } catch {
      // Already read or gone; nothing to do.
    }
  };

  const open = async (m: MentionDto) => {
    await dismiss(m);
    router.push(`/d/${m.documentId}`);
  };

  return (
    <section className="mb-8 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4" aria-label="Mentions" data-testid="mentions-strip">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <AtSign size={15} className="text-accent" /> You were mentioned
      </h2>
      <ul className="flex flex-col gap-1.5">
        {mentions.map((m) => (
          <li key={m.id} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[13px] shadow-sm" data-testid="mention-item" data-mention-id={m.id}>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void open(m)} data-testid="mention-open">
              <span className="text-ink-2">
                <span className="font-medium text-ink">@{m.byLogin ?? "someone"}</span> mentioned you in{" "}
                <span className="font-medium text-ink" data-testid="mention-doc-title">
                  {m.documentTitle}
                </span>
              </span>
              <span className="ml-2 text-xs text-ink-4">{relativeTime(m.createdAt)}</span>
              <span className="mt-0.5 block truncate text-ink-3">{m.snippet}</span>
            </button>
            <button type="button" className="icon-btn h-7 w-7 shrink-0" aria-label="Mark as read" title="Mark as read" onClick={() => void dismiss(m)} data-testid="mention-dismiss">
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
