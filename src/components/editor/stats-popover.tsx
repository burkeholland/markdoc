"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
  useEffect(() => {
    let active = true;
    const update = () => {
      if (!active) return;
      const next = readLocalSelection(session);
      setSel((prev) => (prev?.from === next?.from && prev?.to === next?.to ? prev : next));
    };
    update();
    session.awareness.on("change", update);
    const unsubscribe = session.subscribe(update);
    return () => {
      active = false;
      session.awareness.off("change", update);
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

interface GoalDraft {
  kind: GoalKind;
  mode: GoalMode;
  value: string;
}

function goalDraft(goal: WritingGoal | null): GoalDraft {
  return { kind: goal?.kind ?? "words", mode: goal?.mode ?? "min", value: goal ? String(goal.value) : "" };
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled])";

export function StatsPopover({ session, source, selection, hydrated }: StatsPopoverProps) {
  const [open, setOpen] = useState(false);
  // Navigating to another document closes the popover.
  const [openSession, setOpenSession] = useState(session);
  if (openSession !== session) {
    setOpenSession(session);
    setOpen(false);
  }
  // Which end of the popover to focus when it was opened from the keyboard.
  const focusEdge = useRef<"first" | "last" | null>(null);
  const stats = useMemo(() => computeStats(source), [source]);
  const selStats = useMemo(() => (selection ? computeSelectionStats(source, selection.from, selection.to) : null), [selection, source]);
  const goal = useSessionValue(session, getGoal, jsonEqual);
  const canEdit = useSessionValue(session, (value) => value.canEdit);
  const progress = useMemo(() => (goal ? goalProgress(stats, goal) : null), [goal, stats]);

  const shortcutLabel = shortcut("Mod-Shift-C");
  const triggerLabel = hydrated ? `${formatNumber(stats.words)} words` : "— words";
  const selectionLabel = hydrated && selStats ? `${formatNumber(selStats.words)} of ${formatNumber(stats.words)} selected` : null;
  const triggerTitle = goal && progress ? describeGoal(goal, progress) : `Document statistics (${shortcutLabel})`;

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    focusEdge.current = event.key === "ArrowDown" ? "first" : "last";
    setOpen(true);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) focusEdge.current = null;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink"
          title={triggerTitle}
          onKeyDown={onTriggerKeyDown}
          data-testid="stats-button"
        >
          {goal && progress && hydrated ? <GoalRing progress={progress} /> : null}
          <span data-testid="word-count">{triggerLabel}</span>
          {selectionLabel && (
            <span className="text-ink-4" data-testid="selection-count">
              · {selectionLabel}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[24rem] p-0"
        onOpenAutoFocus={(event) => {
          const edge = focusEdge.current;
          focusEdge.current = null;
          if (!edge) return;
          const controls = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(FOCUSABLE));
          const target = edge === "first" ? controls[0] : controls[controls.length - 1];
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
        data-testid="stats-popover"
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
          <span>Document statistics</span>
          <span className="font-normal normal-case tracking-normal text-ink-4">{shortcutLabel}</span>
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
              const format = row.format ?? formatNumber;
              return (
                <tr key={row.key} data-stat={row.key}>
                  <td className="px-3 py-1 text-ink-2">{row.label}</td>
                  {selStats && <td className="px-3 py-1 text-right tabular-nums text-ink">{format(selStats[row.key])}</td>}
                  <td className="px-3 py-1 text-right tabular-nums text-ink">{format(stats[row.key])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-3 pb-2 text-[11px] text-ink-4">
          Prose only: code blocks and front matter are not counted. Reading at 200 wpm, speaking at 130 wpm.
        </p>
        <GoalEditor key={`${session.docId}:${JSON.stringify(goal)}`} session={session} goal={goal} progress={progress} canEdit={canEdit} />
      </PopoverContent>
    </Popover>
  );
}

function GoalEditor({ session, goal, progress, canEdit }: { session: CollabSession; goal: WritingGoal | null; progress: GoalProgress | null; canEdit: boolean }) {
  // Keyed by the shared goal, so a remote change resets the draft.
  const [draft, setDraft] = useState(() => goalDraft(goal));
  const setDisabled = !(Number(draft.value) > 0);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit) return;
    const value = Math.round(Number(draft.value));
    if (!Number.isFinite(value) || value <= 0) return;
    setGoal(session, { kind: draft.kind, mode: draft.mode, value, setBy: session.user.login ?? null, setAt: Date.now() });
  };

  // Arrow keys, Home and End move between Set and Clear (no wrapping).
  const onActionsKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll("button")).filter((button) => !button.disabled);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const destination =
      event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? index - 1
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    if (destination < 0 || destination >= buttons.length || destination === index) return;
    event.preventDefault();
    buttons[destination].focus();
  };

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
            value={draft.mode}
            onChange={(event) => setDraft({ ...draft, mode: event.target.value === "max" ? "max" : "min" })}
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
            placeholder={draft.kind === "words" ? "500" : "5"}
            value={draft.value}
            onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            aria-label="Goal value"
            data-testid="goal-value"
          />
          <select
            className="select h-8 shrink-0 px-1.5 text-[13px]"
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value === "minutes" ? "minutes" : "words" })}
            aria-label="Goal type"
            data-testid="goal-kind"
          >
            <option value="words">words</option>
            <option value="minutes">min read</option>
          </select>
          <span className="ml-auto inline-flex gap-1.5" onKeyDown={onActionsKeyDown}>
            <button type="submit" className="btn btn-primary btn-sm h-8" disabled={setDisabled} data-testid="goal-set">
              Set
            </button>
            {goal && (
              <button type="button" className="btn btn-ghost btn-sm h-8" onClick={() => setGoal(session, null)} data-testid="goal-clear">
                Clear
              </button>
            )}
          </span>
        </form>
      )}
    </div>
  );
}
