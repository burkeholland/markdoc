"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, GitCommit, History, Loader2, Pencil, RotateCcw, Tag, Upload, X, Download } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api, type VersionSummary } from "@/lib/api";
import { collapseUnchanged, diffStats, wordDiff } from "@/editor/diff";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { EmptyState, Spinner } from "@/components/ui/primitives";
import { useSessionValue } from "./use-session";

export interface VersionsPanelProps {
  session: CollabSession;
  onClose: () => void;
  /** Called with the selected version content to show a diff in place of the editor (null = back to editing). */
  onPreview: (preview: { version: VersionSummary; content: string } | null) => void;
  refreshKey: number;
}

const KIND_LABEL: Record<VersionSummary["kind"], string> = {
  auto: "Autosaved",
  named: "Named version",
  publish: "Published",
  restore: "Restored",
  import: "Imported",
};

function KindIcon({ kind }: { kind: VersionSummary["kind"] }) {
  const cls = "shrink-0";
  switch (kind) {
    case "publish":
      return <Upload size={14} className={cn(cls, "text-accent")} />;
    case "named":
      return <Tag size={14} className={cn(cls, "text-violet-600")} />;
    case "restore":
      return <RotateCcw size={14} className={cn(cls, "text-warning")} />;
    case "import":
      return <Download size={14} className={cn(cls, "text-ink-3")} />;
    default:
      return <Clock size={14} className={cn(cls, "text-ink-4")} />;
  }
}

function groupByDay(versions: VersionSummary[]): { day: string; items: VersionSummary[] }[] {
  const groups = new Map<string, VersionSummary[]>();
  for (const v of versions) {
    const d = new Date(v.createdAt);
    const key = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v);
  }
  return Array.from(groups, ([day, items]) => ({ day, items }));
}

export function VersionsPanel({ session, onClose, onPreview, refreshKey }: VersionsPanelProps) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const canEdit = session.role === "owner" || session.role === "editor";

  const load = useCallback(async () => {
    try {
      const res = await api.documents.versions(session.docId);
      setVersions(res.versions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load versions");
    }
  }, [session.docId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const select = async (v: VersionSummary) => {
    if (selected === v.id) {
      setSelected(null);
      onPreview(null);
      return;
    }
    setSelected(v.id);
    setBusy(v.id);
    try {
      const res = await api.documents.version(session.docId, v.id);
      onPreview({ version: v, content: res.version.content });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load version");
    } finally {
      setBusy(null);
    }
  };

  const restore = async (v: VersionSummary) => {
    if (!confirm(`Restore version ${v.number}? The current text is saved as a version first.`)) return;
    setBusy(v.id);
    try {
      await api.documents.restoreVersion(session.docId, v.id);
      setSelected(null);
      onPreview(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusy(null);
    }
  };

  const rename = async (v: VersionSummary) => {
    const title = draft.trim();
    setRenaming(null);
    if (!title || title === v.title) return;
    await api.documents.renameVersion(session.docId, v.id, title);
    await load();
  };

  const groups = useMemo(() => groupByDay(versions ?? []), [versions]);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="versions-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Version history</span>
        <button
          type="button"
          className="icon-btn h-8 w-8"
          onClick={() => {
            onPreview(null);
            onClose();
          }}
          aria-label="Close version history"
        >
          <X size={16} />
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger">{error}</div>}
        {versions === null ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : versions.length === 0 ? (
          <EmptyState icon={<History size={28} />} title="No versions yet">
            Versions are captured automatically while you edit, and whenever you publish.
          </EmptyState>
        ) : (
          groups.map((g) => (
            <div key={g.day} className="mb-4">
              <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">{g.day}</div>
              <ul className="flex flex-col gap-1">
                {g.items.map((v) => (
                  <li key={v.id}>
                    <div
                      className={cn(
                        "group rounded-lg border px-3 py-2 transition-colors",
                        selected === v.id ? "border-accent bg-surface shadow-sm" : "border-transparent hover:border-line hover:bg-surface",
                      )}
                      data-testid="version-item"
                      data-version-kind={v.kind}
                    >
                      <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => void select(v)}>
                        <KindIcon kind={v.kind} />
                        <div className="min-w-0 flex-1">
                          {renaming === v.id ? (
                            <input
                              autoFocus
                              className="input h-7 text-[13px]"
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onBlur={() => void rename(v)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void rename(v);
                                if (e.key === "Escape") setRenaming(null);
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <div className="truncate text-[13px] font-medium text-ink">{v.title ?? `${KIND_LABEL[v.kind]} · v${v.number}`}</div>
                          )}
                          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                            <span title={formatDateTime(v.createdAt)}>{relativeTime(v.createdAt)}</span>
                            {v.createdByName && <span>· {v.createdByName}</span>}
                            {v.commitSha && (
                              <span className="inline-flex items-center gap-0.5 font-mono text-[11px]" title={v.commitSha}>
                                <GitCommit size={11} /> {v.commitSha.slice(0, 7)}
                              </span>
                            )}
                          </div>
                        </div>
                        {busy === v.id && <Loader2 size={14} className="mt-1 animate-spin text-ink-4" />}
                      </button>
                      {selected === v.id && canEdit && (
                        <div className="mt-2 flex items-center gap-2">
                          <button type="button" className="btn btn-sm btn-primary gap-1.5" onClick={() => void restore(v)} data-testid="version-restore">
                            <RotateCcw size={13} /> Restore
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost gap-1.5"
                            onClick={() => {
                              setDraft(v.title ?? "");
                              setRenaming(v.id);
                            }}
                          >
                            <Pencil size={13} /> Name
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

/** Read-only comparison of a past version against the live document. */
export function VersionDiffView({ session, version, content }: { session: CollabSession; version: VersionSummary; content: string }) {
  const current = useSessionValue(session, (s) => s.ytext.toString());
  const changes = useMemo(() => wordDiff(content, current), [content, current]);
  const stats = useMemo(() => diffStats(changes), [changes]);
  const collapsed = useMemo(() => collapseUnchanged(changes), [changes]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="version-diff">
      <div className="flex h-12 items-center gap-3 border-b border-line px-6">
        <span className="pane-label">Comparing</span>
        <span className="text-sm text-ink-2">
          <span className="font-medium text-ink">{version.title ?? `v${version.number}`}</span> ({formatDateTime(version.createdAt)}) → current
        </span>
        <span className="ml-auto flex items-center gap-3 font-mono text-xs">
          <span className="text-success">+{stats.added} words</span>
          <span className="text-danger">−{stats.removed} words</span>
        </span>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <pre className="md-diff whitespace-pre-wrap break-words px-8 py-6 font-mono text-[14px] leading-7 text-ink-2">
          {collapsed.map((c, i) =>
            "collapsed" in c ? (
              <span key={i} className="my-2 block rounded bg-surface-3 px-2 py-0.5 text-center text-xs text-ink-4">
                ··· {c.collapsed} unchanged words ···
              </span>
            ) : c.added ? (
              <ins key={i}>{c.value}</ins>
            ) : c.removed ? (
              <del key={i}>{c.value}</del>
            ) : (
              <span key={i}>{c.value}</span>
            ),
          )}
        </pre>
      </div>
    </div>
  );
}
