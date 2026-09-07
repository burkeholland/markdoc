"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
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
type StatsSnapshot = DocStats & { stats: DocStats };
type GoalSnapshot = {
  goal: WritingGoal | null;
  kind: GoalKind | null;
  mode: GoalMode | null;
  value: number | null;
  setBy: string | null;
  setAt: number | null;
};
type ProgressSnapshot = {
  progress: GoalProgress | null;
  current: number | null;
  target: number | null;
  fraction: number | null;
  state: GoalProgress["state"] | null;
};

interface GoalDraft {
  session: CollabSession;
  sharedGoal: WritingGoal | null;
  kind: GoalKind;
  mode: GoalMode;
  value: string;
}

interface GoalPresentation {
  session: CollabSession;
  sharedGoal: GoalSnapshot;
  progress: ProgressSnapshot;
  canEdit: boolean;
  draft: GoalDraft;
  kind: GoalKind;
  mode: GoalMode;
  value: string;
  setBy: string | null;
  setDisabled: boolean;
}

interface GoalPublication {
  presentation: GoalPresentation;
  form: HTMLFormElement;
  modeSelect: HTMLSelectElement;
  valueInput: HTMLInputElement;
  kindSelect: HTMLSelectElement;
  setButton: HTMLButtonElement;
  clearButton: HTMLButtonElement | null;
  claimed: boolean;
}

interface StatsDisclosureRender {
  visit: StatsDisclosureVisit;
  session: CollabSession;
  source: string;
  selection: SourceSelection;
  selectionFrom: number | null;
  selectionTo: number | null;
  hydrated: boolean;
  stats: StatsSnapshot;
  selectionStats: StatsSnapshot | null;
  goal: GoalSnapshot;
  canEdit: boolean;
  progress: ProgressSnapshot;
  open: boolean;
  goalPresentation: GoalPresentation;
}

interface StatsDisclosurePublication {
  render: StatsDisclosureRender;
  trigger: HTMLButtonElement;
  content: HTMLDivElement | null;
}

interface StatsDisclosureIntent {
  render: StatsDisclosureRender;
  prove: () => boolean;
}

interface ElementOwner<R, T extends HTMLElement> {
  render: R;
  element: T;
}

function statsSnapshot(stats: DocStats): StatsSnapshot {
  return { stats, ...stats };
}

function statsSnapshotIsExact(snapshot: StatsSnapshot): boolean {
  const stats = snapshot.stats;
  return (
    stats.words === snapshot.words &&
    stats.characters === snapshot.characters &&
    stats.charactersNoSpaces === snapshot.charactersNoSpaces &&
    stats.sentences === snapshot.sentences &&
    stats.paragraphs === snapshot.paragraphs &&
    stats.headings === snapshot.headings &&
    stats.readingMinutes === snapshot.readingMinutes &&
    stats.speakingMinutes === snapshot.speakingMinutes
  );
}

function goalSnapshot(goal: WritingGoal | null): GoalSnapshot {
  return {
    goal,
    kind: goal?.kind ?? null,
    mode: goal?.mode ?? null,
    value: goal?.value ?? null,
    setBy: goal?.setBy ?? null,
    setAt: goal?.setAt ?? null,
  };
}

function goalSnapshotIsExact(snapshot: GoalSnapshot): boolean {
  const goal = snapshot.goal;
  return goal
    ? goal.kind === snapshot.kind &&
        goal.mode === snapshot.mode &&
        goal.value === snapshot.value &&
        goal.setBy === snapshot.setBy &&
        goal.setAt === snapshot.setAt
    : snapshot.kind === null &&
        snapshot.mode === null &&
        snapshot.value === null &&
        snapshot.setBy === null &&
        snapshot.setAt === null;
}

function goalMatchesSnapshot(goal: WritingGoal | null, snapshot: GoalSnapshot): boolean {
  return goal
    ? goal.kind === snapshot.kind &&
        goal.mode === snapshot.mode &&
        goal.value === snapshot.value &&
        goal.setBy === snapshot.setBy &&
        goal.setAt === snapshot.setAt
    : snapshot.kind === null &&
        snapshot.mode === null &&
        snapshot.value === null &&
        snapshot.setBy === null &&
        snapshot.setAt === null;
}

function progressSnapshot(progress: GoalProgress | null): ProgressSnapshot {
  return {
    progress,
    current: progress?.current ?? null,
    target: progress?.target ?? null,
    fraction: progress?.fraction ?? null,
    state: progress?.state ?? null,
  };
}

function progressSnapshotIsExact(snapshot: ProgressSnapshot): boolean {
  const progress = snapshot.progress;
  return progress
    ? progress.current === snapshot.current &&
        progress.target === snapshot.target &&
        progress.fraction === snapshot.fraction &&
        progress.state === snapshot.state
    : snapshot.current === null &&
        snapshot.target === null &&
        snapshot.fraction === null &&
        snapshot.state === null;
}

function goalPresentationIsExact(presentation: GoalPresentation): boolean {
  const draft = presentation.draft;
  return (
    goalSnapshotIsExact(presentation.sharedGoal) &&
    goalMatchesSnapshot(getGoal(presentation.session), presentation.sharedGoal) &&
    progressSnapshotIsExact(presentation.progress) &&
    presentation.session.canEdit === presentation.canEdit &&
    presentation.session.user.login === presentation.setBy &&
    draft.session === presentation.session &&
    draft.sharedGoal === presentation.sharedGoal.goal &&
    draft.kind === presentation.kind &&
    draft.mode === presentation.mode &&
    draft.value === presentation.value
  );
}

function statsDisclosureRenderIsExact(render: StatsDisclosureRender): boolean {
  const selection = render.selection;
  return (
    render.visit.session === render.session &&
    (selection
      ? selection.from === render.selectionFrom && selection.to === render.selectionTo
      : render.selectionFrom === null && render.selectionTo === null) &&
    statsSnapshotIsExact(render.stats) &&
    (!render.selectionStats || statsSnapshotIsExact(render.selectionStats)) &&
    goalSnapshotIsExact(render.goal) &&
    progressSnapshotIsExact(render.progress) &&
    render.session.canEdit === render.canEdit &&
    goalPresentationIsExact(render.goalPresentation)
  );
}

function isGoalMode(value: string): value is GoalMode {
  return value === "min" || value === "max";
}

function isGoalKind(value: string): value is GoalKind {
  return value === "words" || value === "minutes";
}

/**
 * Word count button in the status bar with the statistics popover (Mod-Shift-C): whole-document
 * and selection counts, and the per-document writing goal shared through the Y meta map.
 */
export function StatsPopover({ session, source, selection, hydrated }: StatsPopoverProps) {
  const visit = useMemo<StatsDisclosureVisit>(() => ({ session }), [session]);
  const activeVisitRef = useRef<StatsDisclosureVisit | null>(null);
  const activeDisclosureRef = useRef<StatsDisclosurePublication | null>(null);
  const disclosureIntentRef = useRef<StatsDisclosureIntent | null>(null);
  const triggerOwnerRef = useRef<ElementOwner<StatsDisclosureRender, HTMLButtonElement> | null>(null);
  const contentOwnerRef = useRef<ElementOwner<StatsDisclosureRender, HTMLDivElement> | null>(null);
  const [disclosure, setDisclosure] = useState<StatsDisclosureState>(() => ({ visit, open: false }));
  const ownsDisclosure = disclosure.visit === visit;
  const open = ownsDisclosure && disclosure.open;
  const stats = useMemo(() => computeStats(source), [source]);
  const selStats = useMemo(
    () => (selection ? computeSelectionStats(source, selection.from, selection.to) : null),
    [selection, source],
  );
  const goal = useSessionValue(session, getGoal, jsonEqual);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const progress = goal ? goalProgress(stats, goal) : null;
  const [storedDraft, setDraft] = useState(() => goalDraft(session, goal));
  let draft = storedDraft;
  if (draft.session !== session || draft.sharedGoal !== goal) {
    draft = goalDraft(session, goal);
    setDraft(draft);
  }
  const goalPresentation: GoalPresentation = {
    session,
    sharedGoal: goalSnapshot(goal),
    progress: progressSnapshot(progress),
    canEdit,
    draft,
    kind: draft.kind,
    mode: draft.mode,
    value: draft.value,
    setBy: session.user.login ?? null,
    setDisabled: !(Number(draft.value) > 0),
  };
  const disclosureRender: StatsDisclosureRender = {
    visit,
    session,
    source,
    selection,
    selectionFrom: selection?.from ?? null,
    selectionTo: selection?.to ?? null,
    hydrated,
    stats: statsSnapshot(stats),
    selectionStats: selStats ? statsSnapshot(selStats) : null,
    goal: goalSnapshot(goal),
    canEdit,
    progress: progressSnapshot(progress),
    open,
    goalPresentation,
  };

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

  useLayoutEffect(() => {
    activeVisitRef.current = visit;
    setDisclosure((current) => (current.visit === visit && !current.open ? current : { visit, open: false }));
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyC") {
        if (activeVisitRef.current !== visit) return;
        e.preventDefault();
        disclosureIntentRef.current = null;
        setVisitOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      if (activeVisitRef.current === visit) activeVisitRef.current = null;
      window.removeEventListener("keydown", onKey);
    };
  }, [setVisitOpen, visit]);

  function retireDisclosureElement<T extends HTMLElement>(
    ownerRef: MutableRefObject<ElementOwner<StatsDisclosureRender, T> | null>,
    render: StatsDisclosureRender,
    element: T,
  ) {
    const owner = ownerRef.current;
    if (owner?.render !== render || owner.element !== element) return;
    ownerRef.current = null;
    if (activeDisclosureRef.current?.render === render) activeDisclosureRef.current = null;
    if (disclosureIntentRef.current?.render === render) disclosureIntentRef.current = null;
  }

  function setTriggerRef(element: HTMLButtonElement | null) {
    if (!element) {
      const owner = triggerOwnerRef.current;
      if (owner?.render === disclosureRender) retireDisclosureElement(triggerOwnerRef, disclosureRender, owner.element);
      return;
    }
    triggerOwnerRef.current = { render: disclosureRender, element };
    const publication = activeDisclosureRef.current;
    if (publication?.render === disclosureRender) publication.trigger = element;
    return () => retireDisclosureElement(triggerOwnerRef, disclosureRender, element);
  }

  function setContentRef(element: HTMLDivElement | null) {
    if (!element) {
      const owner = contentOwnerRef.current;
      if (owner?.render === disclosureRender) retireDisclosureElement(contentOwnerRef, disclosureRender, owner.element);
      return;
    }
    contentOwnerRef.current = { render: disclosureRender, element };
    const publication = activeDisclosureRef.current;
    if (publication?.render === disclosureRender) publication.content = element;
    return () => retireDisclosureElement(contentOwnerRef, disclosureRender, element);
  }

  useLayoutEffect(() => {
    const triggerOwner = triggerOwnerRef.current;
    const contentOwner = contentOwnerRef.current;
    const trigger = triggerOwner?.render === disclosureRender ? triggerOwner.element : null;
    const content = contentOwner?.render === disclosureRender ? contentOwner.element : null;
    if (!trigger || !trigger.isConnected || (content && !content.isConnected)) {
      activeDisclosureRef.current = null;
      return;
    }
    const publication = { render: disclosureRender, trigger, content };
    activeDisclosureRef.current = publication;
    if (disclosureIntentRef.current?.render !== disclosureRender) disclosureIntentRef.current = null;
    return () => {
      if (activeDisclosureRef.current === publication) activeDisclosureRef.current = null;
      if (disclosureIntentRef.current?.render === disclosureRender) disclosureIntentRef.current = null;
    };
  });

  function createDisclosureProof(
    render: StatsDisclosureRender,
    source: EventTarget | null,
    expected: "trigger" | "content",
  ) {
    const publication = activeDisclosureRef.current;
    const owner = expected === "trigger" ? triggerOwnerRef.current : contentOwnerRef.current;
    const element = expected === "trigger" ? publication?.trigger : publication?.content;
    if (
      !publication ||
      publication.render !== render ||
      owner?.render !== render ||
      owner.element !== element ||
      !statsDisclosureRenderIsExact(render) ||
      element === null ||
      source !== element ||
      !publication.trigger.isConnected ||
      !element.isConnected
    ) {
      return null;
    }
    return () => {
      const current = activeDisclosureRef.current;
      const currentOwner = expected === "trigger" ? triggerOwnerRef.current : contentOwnerRef.current;
      const currentElement = expected === "trigger" ? current?.trigger : current?.content;
      return (
        current === publication &&
        current.render === render &&
        currentOwner?.render === render &&
        currentOwner.element === element &&
        currentElement === element &&
        source === element &&
        current.trigger.isConnected &&
        element.isConnected &&
        statsDisclosureRenderIsExact(render)
      );
    };
  }

  function authorizeTriggerChange(event: { currentTarget: EventTarget | null }) {
    const prove = createDisclosureProof(disclosureRender, event.currentTarget, "trigger");
    if (prove) disclosureIntentRef.current = { render: disclosureRender, prove };
  }

  function authorizeContentChange(event: { currentTarget: EventTarget | null }) {
    const prove = createDisclosureProof(disclosureRender, event.currentTarget, "content");
    if (prove) disclosureIntentRef.current = { render: disclosureRender, prove };
  }

  function authorizeContentOutside(event: CustomEvent<{ originalEvent: Event }>) {
    const originalTarget = event.detail?.originalEvent?.target;
    const owner = contentOwnerRef.current;
    const content = owner?.render === disclosureRender ? owner.element : null;
    if (
      !originalTarget ||
      event.target !== originalTarget ||
      event.currentTarget !== originalTarget ||
      !(originalTarget instanceof Node) ||
      content?.contains(originalTarget)
    ) {
      return;
    }
    const prove = createDisclosureProof(disclosureRender, content, "content");
    if (prove) disclosureIntentRef.current = { render: disclosureRender, prove };
  }

  function authorizeContentEscape(event: KeyboardEvent) {
    const owner = contentOwnerRef.current;
    const content = owner?.render === disclosureRender ? owner.element : null;
    if (event.key !== "Escape" || !content || event.currentTarget instanceof Element) return;
    const prove = createDisclosureProof(disclosureRender, content, "content");
    if (prove) disclosureIntentRef.current = { render: disclosureRender, prove };
  }

  function onOpenChange(nextOpen: boolean) {
    const publication = activeDisclosureRef.current;
    const intent = disclosureIntentRef.current;
    if (
      publication?.render !== disclosureRender ||
      intent?.render !== disclosureRender ||
      !intent.prove() ||
      !statsDisclosureRenderIsExact(disclosureRender)
    ) {
      return;
    }
    disclosureIntentRef.current = null;
    if (nextOpen === disclosureRender.open) return;
    setVisitOpen(nextOpen);
  }

  const label = hydrated ? `${formatNumber(stats.words)} words` : "— words";
  const selectionLabel = hydrated && selStats ? `${formatNumber(selStats.words)} of ${formatNumber(stats.words)} selected` : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={setTriggerRef}
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink"
          title={goal && progress ? describeGoal(goal, progress) : `Document statistics (${shortcut("Mod-Shift-C")})`}
          onClickCapture={authorizeTriggerChange}
          onClick={authorizeTriggerChange}
          onPointerDownCapture={authorizeTriggerChange}
          onKeyDownCapture={authorizeTriggerChange}
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
        <PopoverContent
          ref={setContentRef}
          align="start"
          className="w-[24rem] p-0"
          onPointerDownCapture={authorizeContentChange}
          onKeyDownCapture={authorizeContentChange}
          onPointerDownOutside={authorizeContentOutside}
          onFocusOutside={authorizeContentOutside}
          onEscapeKeyDown={authorizeContentEscape}
          data-testid="stats-popover"
        >
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
          <GoalEditor presentation={goalPresentation} setDraft={setDraft} />
        </PopoverContent>
      )}
    </Popover>
  );
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

function GoalEditor({
  presentation,
  setDraft,
}: {
  presentation: GoalPresentation;
  setDraft: Dispatch<SetStateAction<GoalDraft>>;
}) {
  const activePublicationRef = useRef<GoalPublication | null>(null);
  const formOwnerRef = useRef<ElementOwner<GoalPresentation, HTMLFormElement> | null>(null);
  const modeOwnerRef = useRef<ElementOwner<GoalPresentation, HTMLSelectElement> | null>(null);
  const valueOwnerRef = useRef<ElementOwner<GoalPresentation, HTMLInputElement> | null>(null);
  const kindOwnerRef = useRef<ElementOwner<GoalPresentation, HTMLSelectElement> | null>(null);
  const setOwnerRef = useRef<ElementOwner<GoalPresentation, HTMLButtonElement> | null>(null);
  const clearOwnerRef = useRef<ElementOwner<GoalPresentation, HTMLButtonElement> | null>(null);
  const { canEdit, kind, mode, value } = presentation;
  const goal = presentation.sharedGoal.goal;
  const progress = presentation.progress.progress;

  function bindElement<T extends HTMLElement>(
    ownerRef: MutableRefObject<ElementOwner<GoalPresentation, T> | null>,
    element: T | null,
  ) {
    if (!element) {
      if (ownerRef.current?.render !== presentation) return;
      ownerRef.current = null;
      if (activePublicationRef.current?.presentation === presentation) activePublicationRef.current = null;
      return;
    }
    const owner: ElementOwner<GoalPresentation, T> = { render: presentation, element };
    ownerRef.current = owner;
    return () => {
      if (ownerRef.current !== owner) return;
      ownerRef.current = null;
      if (activePublicationRef.current?.presentation === presentation) activePublicationRef.current = null;
    };
  }

  useLayoutEffect(() => {
    const form = formOwnerRef.current?.render === presentation ? formOwnerRef.current.element : null;
    const modeSelect = modeOwnerRef.current?.render === presentation ? modeOwnerRef.current.element : null;
    const valueInput = valueOwnerRef.current?.render === presentation ? valueOwnerRef.current.element : null;
    const kindSelect = kindOwnerRef.current?.render === presentation ? kindOwnerRef.current.element : null;
    const setButton = setOwnerRef.current?.render === presentation ? setOwnerRef.current.element : null;
    const clearButton = clearOwnerRef.current?.render === presentation ? clearOwnerRef.current.element : null;
    if (!canEdit || !form || !modeSelect || !valueInput || !kindSelect || !setButton || (goal && !clearButton)) {
      activePublicationRef.current = null;
      return;
    }
    const publication: GoalPublication = {
      presentation,
      form,
      modeSelect,
      valueInput,
      kindSelect,
      setButton,
      clearButton,
      claimed: false,
    };
    activePublicationRef.current = publication;
    return () => {
      if (activePublicationRef.current === publication) activePublicationRef.current = null;
    };
  });

  function currentPublication() {
    const publication = activePublicationRef.current;
    if (
      !publication ||
      publication.presentation !== presentation ||
      !goalPresentationIsExact(presentation) ||
      !canEdit ||
      formOwnerRef.current?.render !== presentation ||
      formOwnerRef.current.element !== publication.form ||
      modeOwnerRef.current?.render !== presentation ||
      modeOwnerRef.current.element !== publication.modeSelect ||
      valueOwnerRef.current?.render !== presentation ||
      valueOwnerRef.current.element !== publication.valueInput ||
      kindOwnerRef.current?.render !== presentation ||
      kindOwnerRef.current.element !== publication.kindSelect ||
      setOwnerRef.current?.render !== presentation ||
      setOwnerRef.current.element !== publication.setButton ||
      (publication.clearButton
        ? clearOwnerRef.current?.render !== presentation || clearOwnerRef.current.element !== publication.clearButton
        : clearOwnerRef.current?.render === presentation)
    ) {
      return null;
    }
    const { form, modeSelect, valueInput, kindSelect, setButton, clearButton } = publication;
    const actions = setButton.parentElement;
    if (
      !form.isConnected ||
      !modeSelect.isConnected ||
      !valueInput.isConnected ||
      !kindSelect.isConnected ||
      !setButton.isConnected ||
      (clearButton && !clearButton.isConnected) ||
      modeSelect.form !== form ||
      valueInput.form !== form ||
      kindSelect.form !== form ||
      setButton.form !== form ||
      (clearButton && clearButton.form !== form) ||
      form.children.length !== 4 ||
      form.children.item(0) !== modeSelect ||
      form.children.item(1) !== valueInput ||
      form.children.item(2) !== kindSelect ||
      !actions ||
      form.children.item(3) !== actions ||
      actions.children.item(0) !== setButton ||
      actions.children.length !== (clearButton ? 2 : 1) ||
      (clearButton && actions.children.item(1) !== clearButton) ||
      setButton.type !== "submit" ||
      setButton.disabled !== presentation.setDisabled ||
      (goal ? !clearButton || clearButton.type !== "button" : clearButton !== null)
    ) {
      return null;
    }
    return publication;
  }

  function claimDraft(
    source: EventTarget | null,
    expected: "modeSelect" | "valueInput" | "kindSelect",
  ) {
    const publication = currentPublication();
    if (!publication || publication.claimed || source !== publication[expected]) return null;
    publication.claimed = true;
    return publication;
  }

  function changeMode(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.currentTarget.value;
    if (!isGoalMode(next) || !claimDraft(event.currentTarget, "modeSelect")) return;
    setDraft({ ...presentation.draft, mode: next });
  }

  function changeValue(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.currentTarget.value;
    if (!claimDraft(event.currentTarget, "valueInput")) return;
    setDraft({ ...presentation.draft, value: next });
  }

  function changeKind(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.currentTarget.value;
    if (!isGoalKind(next) || !claimDraft(event.currentTarget, "kindSelect")) return;
    setDraft({ ...presentation.draft, kind: next });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    const nativeEvent = event.nativeEvent;
    const formOwner = formOwnerRef.current;
    const setOwner = setOwnerRef.current;
    if (
      formOwner?.render !== presentation ||
      setOwner?.render !== presentation ||
      event.currentTarget !== formOwner.element ||
      event.defaultPrevented ||
      !(nativeEvent instanceof SubmitEvent) ||
      nativeEvent.target !== formOwner.element ||
      nativeEvent.defaultPrevented ||
      nativeEvent.submitter !== setOwner.element
    ) {
      return;
    }
    const publication = currentPublication();
    if (
      !publication ||
      publication.claimed ||
      publication.setButton.disabled ||
      publication.modeSelect.value !== presentation.mode ||
      publication.valueInput.value !== presentation.value ||
      publication.kindSelect.value !== presentation.kind
    ) {
      return;
    }
    publication.claimed = true;
    const exactSession = presentation.session;
    const exactKind = presentation.kind;
    const exactMode = presentation.mode;
    const exactValue = presentation.value;
    const exactSetBy = presentation.setBy;
    event.preventDefault();
    const parsed = Math.round(Number(exactValue));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setGoal(exactSession, {
      kind: exactKind,
      mode: exactMode,
      value: parsed,
      setBy: exactSetBy,
      setAt: Date.now(),
    });
  }

  function clear(event: React.MouseEvent<HTMLButtonElement>) {
    const owner = clearOwnerRef.current;
    if (owner?.render !== presentation || event.currentTarget !== owner.element) return;
    const publication = currentPublication();
    if (
      !publication ||
      publication.claimed ||
      !presentation.sharedGoal.goal ||
      event.currentTarget !== publication.clearButton ||
      !publication.clearButton ||
      publication.clearButton.disabled
    ) {
      return;
    }
    publication.claimed = true;
    setGoal(presentation.session, null);
  }

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
        <form ref={(element) => bindElement(formOwnerRef, element)} className="mt-2 flex flex-wrap items-center gap-1.5" onSubmit={submit}>
          <select
            ref={(element) => bindElement(modeOwnerRef, element)}
            className="select h-8 shrink-0 px-1.5 text-[13px]"
            value={mode}
            onChange={changeMode}
            aria-label="Goal mode"
            data-testid="goal-mode"
          >
            <option value="min">At least</option>
            <option value="max">At most</option>
          </select>
          <input
            ref={(element) => bindElement(valueOwnerRef, element)}
            className="input h-8 w-18 shrink-0 px-2 text-[13px] tabular-nums"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={kind === "words" ? "500" : "5"}
            value={value}
            onChange={changeValue}
            aria-label="Goal value"
            data-testid="goal-value"
          />
          <select
            ref={(element) => bindElement(kindOwnerRef, element)}
            className="select h-8 shrink-0 px-1.5 text-[13px]"
            value={kind}
            onChange={changeKind}
            aria-label="Goal type"
            data-testid="goal-kind"
          >
            <option value="words">words</option>
            <option value="minutes">min read</option>
          </select>
          <span className="ml-auto inline-flex gap-1.5">
            <button ref={(element) => bindElement(setOwnerRef, element)} type="submit" className="btn btn-primary btn-sm h-8" disabled={presentation.setDisabled} data-testid="goal-set">
              Set
            </button>
            {goal && (
              <button ref={(element) => bindElement(clearOwnerRef, element)} type="button" className="btn btn-ghost btn-sm h-8" onClick={clear} data-testid="goal-clear">
                Clear
              </button>
            )}
          </span>
        </form>
      )}
    </div>
  );
}
