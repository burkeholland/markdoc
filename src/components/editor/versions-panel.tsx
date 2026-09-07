"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ChevronDown, ChevronUp, Clock, Copy, GitCommit, History, Loader2, MoveVertical, Pencil, RotateCcw, Tag, Upload, X, Download } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api, apiErrorText, type VersionSummary } from "@/lib/api";
import { collapseSegment, detectMoves, diffStats, hunkCounter, hunks, wordDiff, type Collapsed, type DiffSegment } from "@/editor/diff";
import { cn, formatDateTime, formatDayHeading, relativeTime } from "@/lib/utils";
import { setPendingNotice } from "@/lib/notice";
import { EmptyState, Spinner } from "@/components/ui/primitives";
import { useSessionValue } from "./use-session";

/** What the diff view shows: one version against the live text, or (with `base`) two versions. */
export interface VersionPreview {
  version: VersionSummary;
  content: string;
  /** The older side in compare mode; absent = compare against the current document. */
  base?: { version: VersionSummary; content: string };
  /** Versions in (base, version], newest first — whose authors are listed under the header. */
  range?: VersionSummary[];
}

export interface VersionsPanelProps {
  session: CollabSession;
  onClose: () => void;
  /** Called with the selected version(s) to show a diff in place of the editor (null = back to editing). */
  onPreview: (preview: VersionPreview | null) => void;
  refreshKey: number;
}

const KIND_LABEL: Record<VersionSummary["kind"], string> = {
  auto: "Autosaved",
  named: "Named version",
  publish: "Published",
  restore: "Restored",
  import: "Imported",
};

const KIND_TAG: Record<VersionSummary["kind"], string> = {
  auto: "Auto",
  named: "Named",
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
    const key = formatDayHeading(v.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v);
  }
  return Array.from(groups, ([day, items]) => ({ day, items }));
}

/**
 * Last list seen per document, shared by every panel mount. A re-open renders the rows from here in
 * the same frame and refreshes behind them; `prefetchVersions` fills it while the ⋯ menu is open so the
 * first open usually finds it warm too (task #487).
 */
const listCache = new Map<string, VersionSummary[]>();
const inflight = new Map<string, { owner: symbol; promise: Promise<VersionSummary[]> }>();

function fetchVersions(docId: string, options?: { fresh?: boolean; canCommit?: () => boolean }): Promise<VersionSummary[]> {
  const pending = inflight.get(docId);
  if (pending && !options?.fresh) return pending.promise;

  const owner = Symbol(docId);
  const promise = api.documents
    .versions(docId)
    .then((res) => {
      if (inflight.get(docId)?.owner === owner && (options?.canCommit?.() ?? true)) listCache.set(docId, res.versions);
      return res.versions;
    })
    .finally(() => {
      if (inflight.get(docId)?.owner === owner) inflight.delete(docId);
    });
  inflight.set(docId, { owner, promise });
  return promise;
}

/** Warm the version list for `docId` (no-op while a fetch is already running). Errors are left to the panel. */
export function prefetchVersions(docId: string): void {
  void fetchVersions(docId).catch(() => {});
}

export function VersionsPanel(props: VersionsPanelProps) {
  return <VersionsPanelForDocument key={props.session.docId} {...props} />;
}

type VersionMutationIntent =
  | { kind: "restore"; versionId: string }
  | { kind: "rename"; versionId: string; title: string }
  | { kind: "copy"; versionId: string };

type VersionMutationOwner = VersionMutationIntent & {
  operationId: number;
  documentId: string;
};

function VersionsPanelForDocument({ session, onClose, onPreview, refreshKey }: VersionsPanelProps) {
  const router = useRouter();
  const [versions, setVersions] = useState<VersionSummary[] | null>(() => listCache.get(session.docId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [activeMutation, setActiveMutation] = useState<VersionMutationOwner | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const contentCache = useRef(new Map<string, string>());
  const contentRequests = useRef(new Map<string, Promise<string>>());
  const previewIntent = useRef(0);
  const alive = useRef(true);
  const listRequest = useRef(0);
  const retryPending = useRef(false);
  const mutationOperation = useRef(0);
  const mutationOwner = useRef<VersionMutationOwner | null>(null);
  const canEdit = session.role === "owner" || session.role === "editor";
  const mutationBusy = activeMutation !== null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      previewIntent.current += 1;
      listRequest.current += 1;
      mutationOwner.current = null;
    };
  }, []);

  const load = useCallback(async (owner?: VersionMutationOwner) => {
    const request = ++listRequest.current;
    const ownsRequest = () => alive.current && request === listRequest.current && (!owner || mutationOwner.current === owner);
    try {
      const list = await fetchVersions(session.docId, { fresh: Boolean(owner), canCommit: ownsRequest });
      if (!ownsRequest()) return;
      setVersions(list);
      setListError(null);
    } catch (e) {
      if (!ownsRequest()) return;
      setListError(apiErrorText(e, "Failed to load versions"));
    }
  }, [session.docId]);

  const retry = useCallback(() => {
    if (retryPending.current) return;
    retryPending.current = true;
    setRetrying(true);
    void load().finally(() => {
      retryPending.current = false;
      if (alive.current) setRetrying(false);
    });
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const contentOf = useCallback(
    async (v: VersionSummary) => {
      const cached = contentCache.current.get(v.id);
      if (cached !== undefined) return cached;
      const pending = contentRequests.current.get(v.id);
      if (pending) return pending;

      const request = api.documents.version(session.docId, v.id).then((res) => {
        contentCache.current.set(v.id, res.version.content);
        return res.version.content;
      });
      contentRequests.current.set(v.id, request);
      void request.then(
        () => {
          if (contentRequests.current.get(v.id) === request) contentRequests.current.delete(v.id);
        },
        () => {
          if (contentRequests.current.get(v.id) === request) contentRequests.current.delete(v.id);
        },
      );
      return request;
    },
    [session.docId],
  );

  /** Two ticked versions → old→new compare; otherwise fall back to the clicked row vs current, or nothing. */
  const showPreview = useCallback(
    async (compareIds: string[], selectedId: string | null) => {
      const intent = ++previewIntent.current;
      const all = versions ?? [];
      const picked = compareIds.map((id) => all.find((v) => v.id === id)).filter((v): v is VersionSummary => Boolean(v));
      const pair = picked.length === 2 ? [...picked].sort((a, b) => a.number - b.number) : null;
      const single = selectedId ? all.find((v) => v.id === selectedId) : undefined;
      const ownsIntent = () => alive.current && previewIntent.current === intent;

      setError(null);
      setPreviewBusy(pair ? pair[1].id : single?.id ?? null);
      try {
        if (pair) {
          const [older, newer] = pair;
          const [oldContent, newContent] = await Promise.all([contentOf(older), contentOf(newer)]);
          if (!ownsIntent()) return;
          const range = all.filter((v) => v.number > older.number && v.number <= newer.number);
          onPreview({ version: newer, content: newContent, base: { version: older, content: oldContent }, range });
          return;
        }
        if (single) {
          const content = await contentOf(single);
          if (!ownsIntent()) return;
          onPreview({ version: single, content });
          return;
        }
        onPreview(null);
      } catch (e) {
        if (ownsIntent()) setError(apiErrorText(e, "Failed to load version"));
      } finally {
        if (ownsIntent()) setPreviewBusy(null);
      }
    },
    [versions, contentOf, onPreview],
  );

  const invalidatePreview = useCallback(() => {
    previewIntent.current += 1;
    setPreviewBusy(null);
  }, []);

  const claimMutation = useCallback(
    (intent: VersionMutationIntent): VersionMutationOwner | null => {
      if (!alive.current || mutationOwner.current) return null;
      const owner: VersionMutationOwner = {
        ...intent,
        operationId: ++mutationOperation.current,
        documentId: session.docId,
      };
      mutationOwner.current = owner;
      setActiveMutation(owner);
      setError(null);
      return owner;
    },
    [session.docId],
  );

  const ownsMutation = useCallback((owner: VersionMutationOwner) => alive.current && mutationOwner.current === owner, []);

  const releaseMutation = useCallback((owner: VersionMutationOwner) => {
    if (mutationOwner.current !== owner) return;
    mutationOwner.current = null;
    setActiveMutation((current) => (current === owner ? null : current));
  }, []);

  const invalidateMutation = useCallback(() => {
    mutationOwner.current = null;
    setActiveMutation(null);
  }, []);

  const select = async (v: VersionSummary) => {
    const next = selected === v.id ? null : v.id;
    setSelected(next);
    await showPreview(compare, next);
  };

  const toggleCompare = async (v: VersionSummary) => {
    // Keep at most two ticked; ticking a third replaces the older tick.
    const next = compare.includes(v.id) ? compare.filter((id) => id !== v.id) : [...compare.slice(-1), v.id];
    setCompare(next);
    await showPreview(next, selected);
  };

  const restore = async (v: VersionSummary) => {
    if (!alive.current || mutationOwner.current) return;
    if (!confirm(`Restore version ${v.number}? The current text is saved as a version first.`)) return;
    const owner = claimMutation({ kind: "restore", versionId: v.id });
    if (!owner) return;
    invalidatePreview();
    try {
      await api.documents.restoreVersion(session.docId, v.id);
      if (!ownsMutation(owner)) return;
      setSelected(null);
      setCompare([]);
      onPreview(null);
      await load(owner);
    } catch (e) {
      if (ownsMutation(owner)) setError(apiErrorText(e, "Restore failed"));
    } finally {
      releaseMutation(owner);
    }
  };

  const rename = async (v: VersionSummary) => {
    const title = draft.trim();
    setRenaming(null);
    if (!title || title === v.title) return;
    const owner = claimMutation({ kind: "rename", versionId: v.id, title });
    if (!owner) return;
    try {
      await api.documents.renameVersion(session.docId, v.id, title);
      if (!ownsMutation(owner)) return;
      await load(owner);
    } catch (e) {
      if (ownsMutation(owner)) setError(apiErrorText(e, "Rename failed"));
    } finally {
      releaseMutation(owner);
    }
  };

  const copyAsNew = async (v: VersionSummary) => {
    const owner = claimMutation({ kind: "copy", versionId: v.id });
    if (!owner) return;
    try {
      const res = await api.documents.copyVersion(session.docId, v.id);
      if (!ownsMutation(owner)) return;
      setPendingNotice(`Created “${res.title}” from version ${v.number}.`, "success");
      router.push(`/d/${res.id}`);
    } catch (e) {
      if (ownsMutation(owner)) setError(apiErrorText(e, "Could not copy the version"));
    } finally {
      releaseMutation(owner);
    }
  };

  const groups = useMemo(() => groupByDay(versions ?? []), [versions]);
  const compareHint = compare.length === 1 ? "Tick one more version to compare" : compare.length === 2 ? "Comparing two versions" : null;

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="versions-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Version history</span>
        <button
          type="button"
          className="icon-btn h-8 w-8"
          onClick={() => {
            invalidatePreview();
            listRequest.current += 1;
            invalidateMutation();
            onPreview(null);
            onClose();
          }}
          aria-label="Close version history"
        >
          <X size={16} />
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {listError && (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
            <div>{listError}</div>
            <button type="button" className="btn btn-outline btn-sm mt-2 gap-1.5" onClick={retry} disabled={retrying}>
              {retrying && <Loader2 size={13} className="animate-spin" />}
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger">{error}</div>}
        {compareHint && (
          <div className="mb-3 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-1.5 text-xs text-ink-2" data-testid="compare-hint">
            <span>{compareHint}</span>
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => {
                setCompare([]);
                void showPreview([], selected);
              }}
            >
              Clear
            </button>
          </div>
        )}
        {versions === null && !listError ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : versions?.length === 0 ? (
          <EmptyState icon={<History size={28} />} title="No versions yet">
            Versions are captured automatically while you edit, and whenever you publish.
          </EmptyState>
        ) : versions ? (
          groups.map((g) => (
            <div key={g.day} className="mb-4">
              <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">{g.day}</div>
              <ul className="flex flex-col gap-1">
                {g.items.map((v) => (
                  <li key={v.id}>
                    <div
                      className={cn(
                        "group rounded-lg border px-2 py-2 transition-colors",
                        selected === v.id || compare.includes(v.id) ? "border-accent bg-surface shadow-sm" : "border-transparent hover:border-line hover:bg-surface",
                      )}
                      data-testid="version-item"
                      data-version-kind={v.kind}
                      data-version-number={v.number}
                    >
                      <div className="flex items-start gap-2">
                        <label
                          className="-mx-[5px] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center"
                          title="Tick two versions to compare them"
                          data-testid="version-compare-target"
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                            checked={compare.includes(v.id)}
                            onChange={() => void toggleCompare(v)}
                            aria-label={`Compare v${v.number}`}
                            title="Tick two versions to compare them"
                            data-testid="version-compare"
                          />
                        </label>
                        <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => void select(v)}>
                          <KindIcon kind={v.kind} />
                          <div className="min-w-0 flex-1">
                            {renaming === v.id ? (
                              <input
                                autoFocus
                                className="input h-7 text-[13px]"
                                value={draft}
                                placeholder={`Name version ${v.number}`}
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={() => void rename(v)}
                                disabled={mutationBusy}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void rename(v);
                                  }
                                  if (e.key === "Escape") setRenaming(null);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                data-testid="version-rename-input"
                              />
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[13px] font-medium text-ink">{v.title ?? KIND_LABEL[v.kind]}</span>
                                {v.title && (
                                  <span
                                    className="shrink-0 rounded border border-line px-1 text-[10px] font-medium uppercase tracking-wide text-ink-3"
                                    data-testid="version-kind"
                                  >
                                    {KIND_TAG[v.kind]}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                              <span className="font-mono text-[11px] text-ink-4">v{v.number}</span>
                              <span title={formatDateTime(v.createdAt)}>· {relativeTime(v.createdAt)}</span>
                              {v.createdByName && <span>· {v.createdByName}</span>}
                              {v.commitSha && (
                                <span className="inline-flex items-center gap-0.5 font-mono text-[11px]" title={v.commitSha}>
                                  <GitCommit size={11} /> {v.commitSha.slice(0, 7)}
                                </span>
                              )}
                            </div>
                          </div>
                          {(previewBusy === v.id || activeMutation?.versionId === v.id) && <Loader2 size={14} className="mt-1 animate-spin text-ink-4" />}
                        </button>
                      </div>
                      {selected === v.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
                          {canEdit && (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary gap-1.5"
                              onClick={() => void restore(v)}
                              disabled={mutationBusy}
                              data-testid="version-restore"
                            >
                              <RotateCcw size={13} /> Restore
                            </button>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost gap-1.5"
                              onClick={() => {
                                if (mutationOwner.current) return;
                                setDraft(v.title ?? "");
                                setRenaming(v.id);
                              }}
                              disabled={mutationBusy}
                              data-testid="version-rename"
                            >
                              <Pencil size={13} /> {v.title ? "Rename" : "Name"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost gap-1.5"
                            onClick={() => void copyAsNew(v)}
                            disabled={mutationBusy}
                            title="Copy this version as a new document"
                            data-testid="version-copy"
                          >
                            <Copy size={13} /> Copy as new doc
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : null}
      </div>
    </aside>
  );
}

/** One rendered block of the diff: a hunk (all its segments) or a stretch of unchanged text between hunks. */
type Block = { hunk: number; segments: DiffSegment[] } | { gap: (DiffSegment | Collapsed)[] };

function buildBlocks(segments: DiffSegment[], hunkList: { start: number; end: number }[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  hunkList.forEach((h, n) => {
    if (i < h.start) blocks.push({ gap: segments.slice(i, h.start).flatMap((s, k) => collapseSegment(s, i + k === 0, false)) });
    blocks.push({ hunk: n, segments: segments.slice(h.start, h.end + 1) });
    i = h.end + 1;
  });
  if (i < segments.length) blocks.push({ gap: segments.slice(i).flatMap((s, k) => collapseSegment(s, i + k === 0, i + k === segments.length - 1)) });
  return blocks;
}

function Segment({ c }: { c: DiffSegment | Collapsed }) {
  if ("collapsed" in c) {
    return <span className="my-2 block rounded bg-surface-3 px-2 py-0.5 text-center text-xs text-ink-4">··· {c.collapsed} unchanged words ···</span>;
  }
  if (c.moved) {
    return (
      <span className="rounded-sm bg-surface-3 text-ink-2 outline-1 outline-dashed outline-line-2" title="Moved paragraph (unchanged text)" data-testid="diff-moved">
        <MoveVertical size={12} className="mr-1 inline-block align-[-1px] text-ink-3" aria-label="Moved" />
        {c.value}
      </span>
    );
  }
  if (c.added) return <ins>{c.value}</ins>;
  if (c.removed) return <del>{c.value}</del>;
  return <span>{c.value}</span>;
}

function versionLabel(v: VersionSummary) {
  return (
    <>
      <span className="font-medium text-ink">v{v.number}</span>
      {v.title && <span className="text-ink-2"> ‘{v.title}’</span>}
    </>
  );
}

function compactRange(numbers: number[]): string {
  if (numbers.length <= 4) return numbers.map((n) => `v${n}`).join(", ");
  return `v${numbers[0]}–v${numbers[numbers.length - 1]}`;
}

/** Read-only comparison of a past version against the live document, or of two versions (old → new). */
export function VersionDiffView({ session, preview }: { session: CollabSession; preview: VersionPreview }) {
  const { version, content, base, range } = preview;
  const current = useSessionValue(session, (s) => s.ytext.toString());
  const [swapped, setSwapped] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const oldSide = base ? (swapped ? { version, content } : base) : { version, content };
  const newSide = base ? (swapped ? base : { version, content }) : null;
  const oldText = oldSide.content;
  const newText = newSide ? newSide.content : current;

  const segments = useMemo(() => detectMoves(wordDiff(oldText, newText)), [oldText, newText]);
  const stats = useMemo(() => diffStats(segments), [segments]);
  const hunkList = useMemo(() => hunks(segments), [segments]);
  const blocks = useMemo(() => buildBlocks(segments, hunkList), [segments, hunkList]);
  const movedCount = useMemo(() => hunkList.filter((h) => h.kind === "moved").length, [hunkList]);

  useEffect(() => {
    setActive(0);
  }, [oldText, newText]);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const goTo = useCallback(
    (n: number) => {
      if (hunkList.length === 0) return;
      const next = Math.min(Math.max(n, 0), hunkList.length - 1);
      setActive(next);
      bodyRef.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`)?.scrollIntoView({ block: "center" });
    },
    [hunkList.length],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLElement && /^(input|textarea|button)$/i.test(e.target.tagName) && e.key !== "[" && e.key !== "]") return;
    if (e.key === "]") {
      e.preventDefault();
      goTo(active + 1);
    } else if (e.key === "[") {
      e.preventDefault();
      goTo(active - 1);
    }
  };

  const authors = useMemo(() => {
    const names = new Set<string>();
    for (const v of range ?? []) if (v.createdByName) names.add(v.createdByName);
    return Array.from(names);
  }, [range]);
  const rangeNumbers = useMemo(() => (range ?? []).map((v) => v.number).sort((a, b) => a - b), [range]);

  return (
    <div className="flex h-full min-h-0 flex-col outline-none" data-testid="version-diff" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-6 py-2">
        <span className="pane-label">Comparing</span>
        <span className="min-w-0 break-words text-sm text-ink-2" data-testid="diff-header">
          {newSide ? (
            <>
              {versionLabel(oldSide.version)} → {versionLabel(newSide.version)}{" "}
              <span className="text-ink-3">
                ({newSide.version.createdByName ?? "unknown"}, {relativeTime(newSide.version.createdAt)})
              </span>
            </>
          ) : (
            <>
              {versionLabel(version)} <span className="text-ink-3">({formatDateTime(version.createdAt)})</span> → current
            </>
          )}
        </span>
        {base && (
          <button type="button" className="btn btn-sm btn-ghost gap-1" onClick={() => setSwapped((s) => !s)} title="Swap old and new" data-testid="diff-swap">
            <ArrowLeftRight size={13} /> Swap
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-3 font-mono text-xs">
            <span className="text-success">+{stats.added} words</span>
            <span className="text-danger">−{stats.removed} words</span>
            {movedCount > 0 && <span className="text-ink-3">↕ {movedCount} moved</span>}
          </span>
          <span className="ml-2 flex items-center gap-1 rounded-md border border-line bg-surface text-xs text-ink-2">
            <button type="button" className="icon-btn h-7 w-7" onClick={() => goTo(active - 1)} disabled={active <= 0} aria-label="Previous change ([)" title="Previous change ([)" data-testid="diff-prev">
              <ChevronUp size={14} />
            </button>
            <span className="min-w-[7ch] text-center tabular-nums" data-testid="diff-counter">
              {hunkCounter(active, hunkList.length)}
            </span>
            <button
              type="button"
              className="icon-btn h-7 w-7"
              onClick={() => goTo(active + 1)}
              disabled={active >= hunkList.length - 1}
              aria-label="Next change (])"
              title="Next change (])"
              data-testid="diff-next"
            >
              <ChevronDown size={14} />
            </button>
          </span>
        </span>
        {newSide && rangeNumbers.length > 0 && (
          <div className="flex basis-full flex-wrap items-center gap-1.5 text-xs text-ink-3" data-testid="diff-authors">
            <span>
              {compactRange(rangeNumbers)} by{authors.length === 0 && " unknown"}
            </span>
            {authors.map((name) => (
              <span key={name} className="rounded-full border border-line bg-surface px-2 py-0.5 text-ink-2" data-testid="diff-author">
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto" ref={bodyRef}>
        <pre className="md-diff whitespace-pre-wrap break-words px-8 py-6 font-mono text-[14px] leading-7 text-ink-2">
          {blocks.map((b, i) =>
            "hunk" in b ? (
              <span
                key={i}
                data-hunk={b.hunk}
                data-testid={`diff-hunk-${b.hunk + 1}`}
                data-active={b.hunk === active ? "true" : undefined}
                className={cn("rounded-sm", b.hunk === active && "bg-accent-soft shadow-[0_2px_0_0_var(--color-accent)]")}
              >
                {b.segments.map((s, k) => (
                  <Segment key={k} c={s} />
                ))}
              </span>
            ) : (
              b.gap.map((s, k) => <Segment key={`${i}-${k}`} c={s} />)
            ),
          )}
        </pre>
      </div>
    </div>
  );
}
