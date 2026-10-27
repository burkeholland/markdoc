"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ChevronDown, ChevronUp, Clock, Copy, Download, GitCommit, History, Loader2, MoveVertical, Pencil, RefreshCw, RotateCcw, Tag, Upload, X } from "lucide-react";
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

/**
 * Last list seen per document, shared by every panel mount. A re-open renders the rows from here in
 * the same frame and refreshes behind them; `prefetchVersions` fills it while the ⋯ menu is open so the
 * first open usually finds it warm too (task #487).
 */
const listCache = new Map<string, VersionSummary[]>();
const inflight = new Map<
  string,
  { owner: symbol; promise: Promise<VersionSummary[]>; shareable: boolean }
>();

function fetchVersions(docId: string, options?: { fresh?: boolean; canCommit?: () => boolean }): Promise<VersionSummary[]> {
  const pending = inflight.get(docId);
  if (pending?.shareable && !options?.fresh) return pending.promise;

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
  inflight.set(docId, {
    owner,
    promise,
    shareable: !options?.fresh,
  });
  return promise;
}

/** Warm the version list for `docId` (no-op while a fetch is already running). Errors are left to the panel. */
export function prefetchVersions(docId: string): void {
  void fetchVersions(docId).catch(() => {});
}

export function VersionsPanel(props: VersionsPanelProps) {
  return <VersionsPanelForDocument key={props.session.docId} {...props} />;
}
function groupByDay(rows: VersionSummary[]): { day: string; rows: VersionSummary[] }[] {
  const groups = new Map<string, VersionSummary[]>();
  for (const row of rows) {
    const day = formatDayHeading(row.createdAt);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(row);
  }
  return Array.from(groups, ([day, grouped]) => ({ day, rows: grouped }));
}

type ToolbarControl = "refresh" | "close";
type MutationState = { kind: "restore" | "rename" | "copy"; versionId: string };

/** Index an arrow, Home or End key moves to among `enabled`, wrapping at both ends; -1 when nothing moves. */
function rovingDestination(enabled: readonly boolean[], current: number, key: string, vertical: boolean, horizontal: boolean): number {
  if (current < 0 || enabled.length === 0) return -1;
  if (key === "Home" || key === "End") {
    const order = enabled.map((_, i) => i);
    if (key === "End") order.reverse();
    const destination = order.find((i) => enabled[i]) ?? -1;
    return destination === current ? -1 : destination;
  }
  const step =
    (horizontal && key === "ArrowRight") || (vertical && key === "ArrowDown")
      ? 1
      : (horizontal && key === "ArrowLeft") || (vertical && key === "ArrowUp")
        ? -1
        : 0;
  if (!step) return -1;
  for (let offset = 1; offset <= enabled.length; offset++) {
    const index = (current + step * offset + enabled.length * offset) % enabled.length;
    if (enabled[index]) return index === current ? -1 : index;
  }
  return -1;
}

function hasModifier(e: KeyboardEvent) {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing;
}

function VersionsPanelForDocument({ session, onClose, onPreview, refreshKey }: VersionsPanelProps) {
  const router = useRouter();
  const docId = session.docId;
  const canEdit = session.role === "owner" || session.role === "editor";
  const [versions, setVersions] = useState<VersionSummary[] | null>(() => listCache.get(docId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState<"retry" | "manual" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [mutation, setMutation] = useState<MutationState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [toolbarStop, setToolbarStop] = useState<ToolbarControl>("refresh");

  // Stale-response guards: every async result checks that its operation is still the latest of its
  // kind and that the panel is still mounted (Close retires pending work by bumping sequences).
  const alive = useRef(true);
  const listSeq = useRef(0);
  const previewSeq = useRef(0);
  const mutationRef = useRef<MutationState | null>(null);
  const renamingRef = useRef<string | null>(null);
  const versionsRef = useRef(versions);
  const contentCache = useRef(new Map<string, string>());
  const contentRequests = useRef(new Map<string, Promise<string>>());
  const latest = useRef({ onClose, onPreview, router });
  useLayoutEffect(() => {
    versionsRef.current = versions;
    latest.current = { onClose, onPreview, router };
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const invalidatePreview = useCallback(() => {
    previewSeq.current++;
    setPreviewBusy(null);
  }, []);

  const listBusyRef = useRef<"retry" | "manual" | null>(null);
  const load = useCallback(
    async (intent: "initial" | "external" | "manual" | "retry" | "mutation") => {
      if ((intent === "manual" || intent === "retry") && listBusyRef.current === intent) return;
      const id = ++listSeq.current;
      const owns = () => alive.current && listSeq.current === id;
      listBusyRef.current = intent === "retry" || intent === "manual" ? intent : null;
      setListBusy(listBusyRef.current);
      try {
        const list = await fetchVersions(docId, { fresh: intent !== "initial", canCommit: owns });
        if (!owns()) return;
        if (versionsRef.current !== list) invalidatePreview();
        setVersions(list);
        setListError(null);
      } catch (e) {
        if (owns()) setListError(apiErrorText(e, "Failed to load versions"));
      } finally {
        if (owns()) {
          listBusyRef.current = null;
          setListBusy(null);
        }
      }
    },
    [docId, invalidatePreview],
  );

  const lastRefreshKey = useRef<number | null>(null);
  useEffect(() => {
    const first = lastRefreshKey.current === null;
    if (!first && lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    if (!first && mutationRef.current) return;
    void load(first ? "initial" : "external");
  }, [load, refreshKey]);

  const contentOf = useCallback(
    (id: string): Promise<string> => {
      const cached = contentCache.current.get(id);
      if (cached !== undefined) return Promise.resolve(cached);
      const pending = contentRequests.current.get(id);
      if (pending) return pending;
      const request = api.documents.version(docId, id).then((res) => {
        contentCache.current.set(id, res.version.content);
        return res.version.content;
      });
      contentRequests.current.set(id, request);
      const forget = () => {
        if (contentRequests.current.get(id) === request) contentRequests.current.delete(id);
      };
      request.then(forget, forget);
      return request;
    },
    [docId],
  );

  /** Two ticked versions → old→new compare; otherwise fall back to the clicked row vs current, or nothing. */
  const showPreview = async (compareIds: readonly string[], selectedId: string | null) => {
    const rows = versionsRef.current ?? [];
    const picked = compareIds.map((id) => rows.find((row) => row.id === id)).filter((row): row is VersionSummary => Boolean(row));
    const pair = picked.length === 2 ? [...picked].sort((a, b) => a.number - b.number) : null;
    const single = selectedId ? rows.find((row) => row.id === selectedId) : undefined;
    const id = ++previewSeq.current;
    const owns = () => alive.current && previewSeq.current === id;
    setPreviewBusy(pair ? pair[1].id : single?.id ?? null);
    setError(null);
    try {
      if (pair) {
        const [older, newer] = pair;
        const [oldContent, newContent] = await Promise.all([contentOf(older.id), contentOf(newer.id)]);
        if (!owns()) return;
        const range = rows.filter((row) => row.number > older.number && row.number <= newer.number);
        latest.current.onPreview({ version: newer, content: newContent, base: { version: older, content: oldContent }, range });
      } else if (single) {
        const content = await contentOf(single.id);
        if (!owns()) return;
        latest.current.onPreview({ version: single, content });
      } else if (owns()) {
        latest.current.onPreview(null);
      }
    } catch (e) {
      if (owns()) setError(apiErrorText(e, "Failed to load version"));
    } finally {
      if (owns()) setPreviewBusy(null);
    }
  };

  /** One mutation at a time: returns a release function, or null while another is running. */
  const beginMutation = (next: MutationState) => {
    if (mutationRef.current) return null;
    mutationRef.current = next;
    setMutation(next);
    setError(null);
    return {
      owns: () => alive.current && mutationRef.current === next,
      release: () => {
        if (mutationRef.current !== next) return;
        mutationRef.current = null;
        if (alive.current) setMutation(null);
      },
    };
  };

  const select = (row: VersionSummary) => {
    const next = selected === row.id ? null : row.id;
    setSelected(next);
    void showPreview(compare, next);
  };

  const toggleCompare = (row: VersionSummary) => {
    // Keep at most two ticked; ticking a third replaces the older tick.
    const next = compare.includes(row.id) ? compare.filter((id) => id !== row.id) : [...compare.slice(-1), row.id];
    setCompare(next);
    void showPreview(next, selected);
  };

  const restore = async (row: VersionSummary) => {
    if (mutationRef.current) return;
    if (!window.confirm(`Restore version ${row.number}? The current text is saved as a version first.`)) return;
    const owner = beginMutation({ kind: "restore", versionId: row.id });
    if (!owner) return;
    invalidatePreview();
    try {
      await api.documents.restoreVersion(docId, row.id);
      if (!owner.owns()) return;
      setSelected(null);
      setCompare([]);
      latest.current.onPreview(null);
      await load("mutation");
    } catch (e) {
      if (owner.owns()) setError(apiErrorText(e, "Restore failed"));
    } finally {
      owner.release();
    }
  };

  const rename = async (row: VersionSummary) => {
    if (renamingRef.current !== row.id) return;
    renamingRef.current = null;
    setRenaming(null);
    const title = draft.trim();
    if (!title || title === row.title) return;
    const owner = beginMutation({ kind: "rename", versionId: row.id });
    if (!owner) return;
    try {
      await api.documents.renameVersion(docId, row.id, title);
      if (!owner.owns()) return;
      await load("mutation");
    } catch (e) {
      if (owner.owns()) setError(apiErrorText(e, "Rename failed"));
    } finally {
      owner.release();
    }
  };

  const copyAsNew = async (row: VersionSummary) => {
    const owner = beginMutation({ kind: "copy", versionId: row.id });
    if (!owner) return;
    try {
      const res = await api.documents.copyVersion(docId, row.id);
      if (!owner.owns()) return;
      setPendingNotice(`Created “${res.title}” from version ${row.number}.`, "success");
      latest.current.router.push(`/d/${res.id}`);
    } catch (e) {
      if (owner.owns()) setError(apiErrorText(e, "Could not copy the version"));
    } finally {
      owner.release();
    }
  };

  const close = () => {
    listSeq.current++;
    previewSeq.current++;
    mutationRef.current = null;
    listBusyRef.current = null;
    setMutation(null);
    setPreviewBusy(null);
    setListBusy(null);
    latest.current.onPreview(null);
    latest.current.onClose();
  };

  const startRename = (row: VersionSummary) => {
    setDraft(row.title ?? "");
    renamingRef.current = row.id;
    setRenaming(row.id);
  };

  const refreshing = listBusy === "manual";
  const retrying = listBusy === "retry";
  const mutationBusy = mutation !== null;
  const currentToolbarStop: ToolbarControl = toolbarStop === "refresh" && !refreshing ? "refresh" : "close";

  const onToolbarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || hasModifier(e)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
    const destination = rovingDestination(
      buttons.map((button) => !button.disabled),
      buttons.indexOf(e.target as HTMLButtonElement),
      e.key,
      true,
      true,
    );
    if (destination < 0) return;
    e.preventDefault();
    buttons[destination].focus({ preventScroll: true });
    setToolbarStop(destination === 0 ? "refresh" : "close");
  };

  const rootRef = useRef<HTMLElement>(null);
  const onRowSelectKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // The rename input lives inside the row button: its keys are its own.
    if (e.target !== e.currentTarget || e.defaultPrevented || hasModifier(e)) return;
    const selects = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-version-select]") ?? []);
    const destination = rovingDestination(
      selects.map((button) => !button.disabled),
      selects.indexOf(e.currentTarget),
      e.key,
      true,
      false,
    );
    if (destination < 0) return;
    e.preventDefault();
    selects[destination].focus();
  };

  const compareHint =
    compare.length === 1 ? "Select one more version to compare" : compare.length === 2 ? "Comparing two versions" : null;

  return (
    <aside ref={rootRef} className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="versions-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Version history</span>
        <div
          className="flex items-center gap-1"
          role="toolbar"
          aria-label="Version history actions"
          aria-orientation="horizontal"
          onKeyDown={onToolbarKeyDown}
        >
          <button
            type="button"
            className="icon-btn h-8 w-8"
            onClick={() => void load("manual")}
            onFocus={() => setToolbarStop("refresh")}
            tabIndex={currentToolbarStop === "refresh" ? 0 : -1}
            disabled={refreshing}
            aria-label="Refresh versions"
            aria-busy={refreshing || undefined}
            title="Refresh versions"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            className="icon-btn h-8 w-8"
            onClick={close}
            onFocus={() => setToolbarStop("close")}
            tabIndex={currentToolbarStop === "close" ? 0 : -1}
            aria-label="Close version history"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {listError && (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
            <div className="wrap-anywhere">{listError}</div>
            <button
              type="button"
              className="btn btn-outline btn-sm mt-2 gap-1.5"
              onClick={() => void load("retry")}
              disabled={retrying}
            >
              {retrying && <Loader2 size={13} className="animate-spin" />}
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger wrap-anywhere">{error}</div>}
        {versions?.length && compare.length === 0 && (
          <div id="compare-instruction" className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink-2" data-testid="compare-instruction">
            Select two versions below to compare their changes.
          </div>
        )}
        {compareHint && (
          <div id="compare-hint" className="mb-3 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-1.5 text-xs text-ink-2" data-testid="compare-hint">
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
          groupByDay(versions).map((group) => (
            <div key={group.day} className="mb-4">
              <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">{group.day}</div>
              <ul className="flex flex-col gap-1">
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <div
                      className={cn(
                        "group rounded-lg border px-2 py-2 transition-colors",
                        selected === row.id || compare.includes(row.id) ? "border-accent bg-surface shadow-sm" : "border-transparent hover:border-line hover:bg-surface",
                      )}
                      data-testid="version-item"
                      data-version-kind={row.kind}
                      data-version-number={row.number}
                    >
                      <div className="flex items-start gap-2">
                        <label
                          className="-mx-[5px] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center"
                          title="Select two versions to compare"
                          data-testid="version-compare-target"
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                            checked={compare.includes(row.id)}
                            onChange={() => toggleCompare(row)}
                            aria-label={`Compare v${row.number}`}
                            aria-describedby={compareHint ? "compare-hint" : "compare-instruction"}
                            title="Select two versions to compare"
                            data-testid="version-compare"
                          />
                        </label>
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          onClick={() => select(row)}
                          onKeyDown={onRowSelectKeyDown}
                          data-version-select=""
                        >
                          <KindIcon kind={row.kind} />
                          <div className="min-w-0 flex-1">
                            {renaming === row.id ? (
                              <input
                                autoFocus
                                className="input h-7 text-[13px]"
                                value={draft}
                                placeholder={`Name version ${row.number}`}
                                onChange={(e) => setDraft(e.currentTarget.value)}
                                onBlur={() => void rename(row)}
                                disabled={mutationBusy}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void rename(row);
                                  } else if (e.key === "Escape") {
                                    renamingRef.current = null;
                                    setRenaming(null);
                                  }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                data-testid="version-rename-input"
                              />
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[13px] font-medium text-ink" title={row.title ?? KIND_LABEL[row.kind]}>{row.title ?? KIND_LABEL[row.kind]}</span>
                                {row.title && (
                                  <span className="shrink-0 rounded border border-line px-1 text-[10px] font-medium uppercase tracking-wide text-ink-3" data-testid="version-kind">
                                    {KIND_TAG[row.kind]}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                              <span className="font-mono text-[11px] text-ink-4">v{row.number}</span>
                              <span title={formatDateTime(row.createdAt)}>· {relativeTime(row.createdAt)}</span>
                              {row.createdByName && <span>· {row.createdByName}</span>}
                              {row.commitSha && (
                                <span className="inline-flex items-center gap-0.5 font-mono text-[11px]" title={row.commitSha}>
                                  <GitCommit size={11} /> {row.commitSha.slice(0, 7)}
                                </span>
                              )}
                            </div>
                          </div>
                          {(previewBusy === row.id || mutation?.versionId === row.id) && <Loader2 size={14} className="mt-1 animate-spin text-ink-4" />}
                        </button>
                      </div>
                      {selected === row.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
                          {canEdit && (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary gap-1.5"
                              onClick={() => void restore(row)}
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
                              onClick={() => startRename(row)}
                              disabled={mutationBusy}
                              data-testid="version-rename"
                            >
                              <Pencil size={13} /> {row.title ? "Rename" : "Name"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost gap-1.5"
                            onClick={() => void copyAsNew(row)}
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
  const goTo = useCallback(
    (n: number) => {
      if (hunkList.length === 0) return;
      const next = Math.min(Math.max(n, 0), hunkList.length - 1);
      setActive(next);
      bodyRef.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`)?.scrollIntoView({ block: "center" });
    },
    [hunkList.length],
  );

  useEffect(() => {
    setActive(0);
  }, [oldText, newText]);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // Arrow keys, Home and End move between the enabled header actions (Swap, Previous, Next).
  const onHeaderKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || hasModifier(e)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll("button")).filter((button) => !button.disabled);
    const index = buttons.indexOf(e.target as HTMLButtonElement);
    if (index < 0) return;
    const destination =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? index - 1
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? index + 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : -1;
    if (destination < 0 || destination >= buttons.length || destination === index) return;
    e.preventDefault();
    e.stopPropagation();
    buttons[destination].focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const key = e.key;
    if (key === "Home" || key === "End") {
      // Home and End jump to the first or last change while the diff itself has focus.
      if (e.target !== e.currentTarget || hasModifier(e) || hunkList.length === 0) return;
      e.preventDefault();
      goTo(key === "Home" ? 0 : hunkList.length - 1);
      return;
    }
    if (key === "]") {
      e.preventDefault();
      goTo(active + 1);
    } else if (key === "[") {
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
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-6 py-2" onKeyDown={onHeaderKeyDown}>
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
            <button
              type="button"
              className="icon-btn h-7 w-7"
              onClick={() => goTo(active - 1)}
              disabled={active <= 0}
              aria-label="Previous change ([)"
              title="Previous change ([)"
              data-testid="diff-prev"
            >
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
