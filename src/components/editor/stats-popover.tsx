"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import type { CollabSession } from "@/editor/collab/session";
import { getGoal, setGoal } from "@/editor/collab/meta";
import { computeSelectionStats, computeStats, goalProgress, type DocStats, type GoalKind, type GoalMode, type GoalProgress, type WritingGoal } from "@/editor/stats";
import { cn, formatNumber, shortcut } from "@/lib/utils";
import { jsonEqual, useSessionValue } from "./use-session";

/** Source range `[from, to]` of the local user's selection, or null when the caret is collapsed / unknown. */
export type SourceSelection = { from: number; to: number } | null;

type RelJSON = Parameters<typeof Y.createRelativePositionFromJSON>[0];
type SelectionAuthority = { session: CollabSession };

function resolve(session: CollabSession, rel: unknown): number | null {
  if (!rel) return null;
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel as RelJSON), session.ydoc);
    return abs && abs.type === session.ytext ? abs.index : null;
  } catch {
    return null;
  }
}

function readLocalSelection(session: CollabSession): SourceSelection {
  const cursor = session.awareness.getLocalState()?.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
  if (!cursor) return null;
  const a = resolve(session, cursor.anchor);
  const h = resolve(session, cursor.head);
  if (a === null || h === null || a === h) return null;
  return { from: Math.min(a, h), to: Math.max(a, h) };
}

/**
 * The local selection as source offsets, read from the awareness cursor both editing surfaces
 * publish (so the status bar needs no wiring into the panes). Updates on awareness and text changes.
 */
export function useLocalSelection(session: CollabSession): SourceSelection {
  const [sel, setSel] = useState<SourceSelection>(null);
  const authorityRef = useRef<SelectionAuthority | null>(null);
  useLayoutEffect(() => {
    const authority = { session };
    authorityRef.current = authority;
    const update = () => {
      if (authorityRef.current !== authority) return;
      const next = readLocalSelection(authority.session);
      if (authorityRef.current !== authority) return;
      setSel((prev) => {
        if (authorityRef.current !== authority) return prev;
        return prev?.from === next?.from && prev?.to === next?.to ? prev : next;
      });
    };
    update();
    authority.session.awareness.on("change", update);
    const unsubscribe = authority.session.subscribe(update);
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      authority.session.awareness.off("change", update);
      unsubscribe();
    };
  }, [session]);
  return sel;
}

/** 16 px SVG progress ring; colour follows the goal state. */
export function GoalRing({ progress, className }: { progress: GoalProgress; className?: string }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const dash = c * progress.fraction;
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      className={cn("shrink-0 -rotate-90", progress.state === "reached" ? "text-success" : progress.state === "exceeded" ? "text-warning" : "text-accent", className)}
      data-testid="goal-ring"
      data-state={progress.state}
      aria-hidden
    >
      <circle cx={8} cy={8} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2.5} />
      <circle cx={8} cy={8} r={r} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${dash} ${c - dash}`} />
    </svg>
  );
}

function minutesLabel(m: number): string {
  return m === 0 ? "0 min" : m < 1 ? "< 1 min" : `${formatNumber(m)} min`;
}

const ROWS: { key: keyof DocStats; label: string; format?: (v: number) => string }[] = [
  { key: "words", label: "Words" },
  { key: "characters", label: "Characters" },
  { key: "charactersNoSpaces", label: "Characters (no spaces)" },
  { key: "sentences", label: "Sentences" },
  { key: "paragraphs", label: "Paragraphs" },
  { key: "headings", label: "Headings" },
  { key: "readingMinutes", label: "Reading time", format: minutesLabel },
  { key: "speakingMinutes", label: "Speaking time", format: minutesLabel },
];

export function describeGoal(goal: WritingGoal, progress: GoalProgress): string {
  const unit = goal.kind === "words" ? "words" : "min read";
  return `${formatNumber(progress.current)} / ${formatNumber(progress.target)} ${unit}`;
}

export interface StatsPopoverProps {
  session: CollabSession;
  /** Markdown source the stats are computed from. */
  source: string;
  selection: SourceSelection;
  /** False during server render / before hydration: show placeholders so markup matches. */
  hydrated: boolean;
}

type StatsDisclosureVisit = { session: CollabSession };
type StatsDisclosureState = { visit: StatsDisclosureVisit; open: boolean };

/**
 * Word count button in the status bar with the statistics popover (Mod-Shift-C): whole-document
 * and selection counts, and the per-document writing goal shared through the Y meta map.
 */
export function StatsPopover({ session, source, selection, hydrated }: StatsPopoverProps) {
  const visit = useMemo<StatsDisclosureVisit>(() => ({ session }), [session]);
  const activeVisitRef = useRef<StatsDisclosureVisit | null>(null);
  const [disclosure, setDisclosure] = useState<StatsDisclosureState>(() => ({ visit, open: false }));
  const ownsDisclosure = disclosure.visit === visit;
  const open = ownsDisclosure && disclosure.open;
  const stats = computeStats(source);
  const selStats = selection ? computeSelectionStats(source, selection.from, selection.to) : null;
  const goal = useSessionValue(session, getGoal, jsonEqual);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const progress = goal ? goalProgress(stats, goal) : null;

  const setVisitOpen = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      if (activeVisitRef.current !== visit) return;
      setDisclosure((current) => {
        if (activeVisitRef.current !== visit) return current;
        const currentOpen = current.visit === visit ? current.open : false;
        const nextOpen = typeof next === "function" ? next(currentOpen) : next;
        return current.visit === visit && current.open === nextOpen ? current : { visit, open: nextOpen };
      });
    },
    [visit],
  );

  const onOpenChange = useCallback((nextOpen: boolean) => setVisitOpen(nextOpen), [setVisitOpen]);

  useLayoutEffect(() => {
    activeVisitRef.current = visit;
    setDisclosure((current) => (current.visit === visit && !current.open ? current : { visit, open: false }));
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyC") {
        if (activeVisitRef.current !== visit) return;
        e.preventDefault();
        setVisitOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      if (activeVisitRef.current === visit) activeVisitRef.current = null;
      window.removeEventListener("keydown", onKey);
    };
  }, [setVisitOpen, visit]);

  const label = hydrated ? `${formatNumber(stats.words)} words` : "— words";
  const selectionLabel = hydrated && selStats ? `${formatNumber(selStats.words)} of ${formatNumber(stats.words)} selected` : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink"
          title={goal && progress ? describeGoal(goal, progress) : `Document statistics (${shortcut("Mod-Shift-C")})`}
          data-testid="stats-button"
        >
          {goal && progress && hydrated ? <GoalRing progress={progress} /> : null}
          <span data-testid="word-count">{label}</span>
          {selectionLabel && (
            <span className="text-ink-4" data-testid="selection-count">
              · {selectionLabel}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {ownsDisclosure && (
        <PopoverContent align="start" className="w-[24rem] p-0" data-testid="stats-popover">
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
            <span>Document statistics</span>
            <span className="font-normal normal-case tracking-normal text-ink-4">{shortcut("Mod-Shift-C")}</span>
          </div>
          <table className="w-full text-[13px]" data-testid="stats-table">
            {selStats && (
              <thead>
                <tr className="text-xs text-ink-4">
                  <th className="px-3 pt-2 text-left font-normal" />
                  <th className="px-3 pt-2 text-right font-normal">Selection</th>
                  <th className="px-3 pt-2 text-right font-normal">Document</th>
                </tr>
              </thead>
            )}
            <tbody>
              {ROWS.map((row) => {
                const fmt = row.format ?? formatNumber;
                return (
                  <tr key={row.key} data-stat={row.key}>
                    <td className="px-3 py-1 text-ink-2">{row.label}</td>
                    {selStats && <td className="px-3 py-1 text-right tabular-nums text-ink">{fmt(selStats[row.key])}</td>}
                    <td className="px-3 py-1 text-right tabular-nums text-ink">{fmt(stats[row.key])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-3 pb-2 text-[11px] text-ink-4">Prose only: code blocks and front matter are not counted. Reading at 200 wpm, speaking at 130 wpm.</p>
          <GoalEditor session={session} goal={goal} progress={progress} canEdit={canEdit} />
        </PopoverContent>
      )}
    </Popover>
  );
}

interface GoalDraft {
  session: CollabSession;
  sharedGoal: WritingGoal | null;
  kind: GoalKind;
  mode: GoalMode;
  value: string;
}

function goalDraft(session: CollabSession, goal: WritingGoal | null): GoalDraft {
  return {
    session,
    sharedGoal: goal,
    kind: goal?.kind ?? "words",
    mode: goal?.mode ?? "min",
    value: goal ? String(goal.value) : "",
  };
}

function GoalEditor({ session, goal, progress, canEdit }: { session: CollabSession; goal: WritingGoal | null; progress: GoalProgress | null; canEdit: boolean }) {
  const [storedDraft, setDraft] = useState(() => goalDraft(session, goal));
  let draft = storedDraft;
  if (draft.session !== session || draft.sharedGoal !== goal) {
    draft = goalDraft(session, goal);
    setDraft(draft);
  }
  const { kind, mode, value } = draft;

  const submit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const n = Math.round(Number(value));
      if (!canEdit || !Number.isFinite(n) || n <= 0) return;
      setGoal(session, { kind, mode, value: n, setBy: session.user.login ?? null, setAt: Date.now() });
    },
    [canEdit, kind, mode, session, value],
  );
  const clear = useCallback(() => {
    if (!canEdit) return;
    setGoal(session, null);
  }, [canEdit, session]);

  const summary =
    goal && progress ? (
      <div className="flex items-center gap-2 text-[13px] text-ink-2" data-testid="goal-summary" data-state={progress.state}>
        <GoalRing progress={progress} />
        <span>
          {goal.mode === "min" ? "At least" : "At most"} {formatNumber(goal.value)} {goal.kind === "words" ? "words" : "min read"} · {describeGoal(goal, progress)}
          {progress.state === "reached" && " · reached"}
          {progress.state === "exceeded" && " · over"}
        </span>
      </div>
    ) : (
      <div className="text-[13px] text-ink-4" data-testid="goal-summary" data-state="none">
        No goal set{canEdit ? "" : " for this document"}.
      </div>
    );

  return (
    <div className="border-t border-line px-3 py-2.5" data-testid="goal-section">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">Goal</div>
      {summary}
      {goal?.setBy && <div className="mt-0.5 text-[11px] text-ink-4">Set by @{goal.setBy}; shared with everyone on this document.</div>}
      {canEdit && (
        <form className="mt-2 flex flex-wrap items-center gap-1.5" onSubmit={submit}>
          <select
            className="select h-8 shrink-0 px-1.5 text-[13px]"
            value={mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as GoalMode })}
            aria-label="Goal mode"
            data-testid="goal-mode"
          >
            <option value="min">At least</option>
            <option value="max">At most</option>
          </select>
          <input
            className="input h-8 w-18 shrink-0 px-2 text-[13px] tabular-nums"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={kind === "words" ? "500" : "5"}
            value={value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            aria-label="Goal value"
            data-testid="goal-value"
          />
          <select
            className="select h-8 shrink-0 px-1.5 text-[13px]"
            value={kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as GoalKind })}
            aria-label="Goal type"
            data-testid="goal-kind"
          >
            <option value="words">words</option>
            <option value="minutes">min read</option>
          </select>
          <span className="ml-auto inline-flex gap-1.5">
            <button type="submit" className="btn btn-primary btn-sm h-8" disabled={!(Number(value) > 0)} data-testid="goal-set">
              Set
            </button>
            {goal && (
              <button type="button" className="btn btn-ghost btn-sm h-8" onClick={clear} data-testid="goal-clear">
                Clear
              </button>
            )}
          </span>
        </form>
      )}
    </div>
  );
}
