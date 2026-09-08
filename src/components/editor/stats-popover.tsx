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

interface GoalElementSlot<T extends HTMLElement> {
  expected: T | null;
  connection: { element: T } | null;
}

interface GoalGeneration {
  presentation: GoalPresentation;
  form: GoalElementSlot<HTMLFormElement>;
  modeSelect: GoalElementSlot<HTMLSelectElement>;
  valueInput: GoalElementSlot<HTMLInputElement>;
  kindSelect: GoalElementSlot<HTMLSelectElement>;
  setButton: GoalElementSlot<HTMLButtonElement>;
  clearButton: GoalElementSlot<HTMLButtonElement>;
}

interface GoalPublication {
  generation: GoalGeneration;
  presentation: GoalPresentation;
  form: HTMLFormElement;
  modeSelect: HTMLSelectElement;
  modeMinOption: HTMLOptionElement;
  modeMaxOption: HTMLOptionElement;
  valueInput: HTMLInputElement;
  kindSelect: HTMLSelectElement;
  kindWordsOption: HTMLOptionElement;
  kindMinutesOption: HTMLOptionElement;
  actions: HTMLSpanElement;
  setButton: HTMLButtonElement;
  clearButton: HTMLButtonElement | null;
  claimed: boolean;
  retired: boolean;
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
    draft.value === presentation.value &&
    presentation.setDisabled === !(Number(presentation.value) > 0)
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

function goalElementSlot<T extends HTMLElement>(): GoalElementSlot<T> {
  return { expected: null, connection: null };
}

const claimedGoalNativeEvents = new WeakSet<Event>();

function goalSelectValueIsExact(
  select: HTMLSelectElement,
  value: string,
  selected: HTMLOptionElement,
  other: HTMLOptionElement,
): boolean {
  return (
    select.value === value &&
    select.selectedIndex === selected.index &&
    select.selectedOptions.length === 1 &&
    select.selectedOptions.item(0) === selected &&
    selected.selected &&
    !other.selected
  );
}

function goalPublicationDomIsExact(
  publication: GoalPublication,
  mutable: "modeSelect" | "valueInput" | "kindSelect" | null,
): boolean {
  const {
    presentation,
    form,
    modeSelect,
    modeMinOption,
    modeMaxOption,
    valueInput,
    kindSelect,
    kindWordsOption,
    kindMinutesOption,
    actions,
    setButton,
    clearButton,
  } = publication;
  const document = form.ownerDocument;
  const ownerWindow = document.defaultView;
  const nodes = [
    form,
    modeSelect,
    modeMinOption,
    modeMaxOption,
    valueInput,
    kindSelect,
    kindWordsOption,
    kindMinutesOption,
    actions,
    setButton,
    ...(clearButton ? [clearButton] : []),
  ];
  if (
    !ownerWindow ||
    nodes.some((node) => node.ownerDocument !== document || !node.isConnected) ||
    form.children.length !== 4 ||
    form.children.item(0) !== modeSelect ||
    form.children.item(1) !== valueInput ||
    form.children.item(2) !== kindSelect ||
    form.children.item(3) !== actions ||
    modeSelect.form !== form ||
    valueInput.form !== form ||
    kindSelect.form !== form ||
    setButton.form !== form ||
    modeSelect.children.length !== 2 ||
    modeSelect.children.item(0) !== modeMinOption ||
    modeSelect.children.item(1) !== modeMaxOption ||
    modeSelect.options.length !== 2 ||
    modeSelect.options.item(0) !== modeMinOption ||
    modeSelect.options.item(1) !== modeMaxOption ||
    kindSelect.children.length !== 2 ||
    kindSelect.children.item(0) !== kindWordsOption ||
    kindSelect.children.item(1) !== kindMinutesOption ||
    kindSelect.options.length !== 2 ||
    kindSelect.options.item(0) !== kindWordsOption ||
    kindSelect.options.item(1) !== kindMinutesOption ||
    actions.parentElement !== form ||
    actions.children.length !== (clearButton ? 2 : 1) ||
    actions.children.item(0) !== setButton ||
    (clearButton ? actions.children.item(1) !== clearButton || clearButton.form !== form : actions.children.item(1) !== null) ||
    modeMinOption.value !== "min" ||
    modeMinOption.textContent !== "At least" ||
    modeMinOption.disabled ||
    modeMaxOption.value !== "max" ||
    modeMaxOption.textContent !== "At most" ||
    modeMaxOption.disabled ||
    kindWordsOption.value !== "words" ||
    kindWordsOption.textContent !== "words" ||
    kindWordsOption.disabled ||
    kindMinutesOption.value !== "minutes" ||
    kindMinutesOption.textContent !== "min read" ||
    kindMinutesOption.disabled ||
    modeSelect.disabled ||
    valueInput.disabled ||
    kindSelect.disabled ||
    valueInput.type !== "number" ||
    valueInput.min !== "1" ||
    valueInput.step !== "1" ||
    valueInput.inputMode !== "numeric" ||
    valueInput.placeholder !== (presentation.kind === "words" ? "500" : "5") ||
    setButton.type !== "submit" ||
    setButton.disabled !== presentation.setDisabled ||
    (clearButton ? clearButton.type !== "button" || clearButton.disabled : presentation.sharedGoal.goal !== null) ||
    Boolean(clearButton) !== Boolean(presentation.sharedGoal.goal)
  ) {
    return false;
  }
  const expectedModeOption = presentation.mode === "min" ? modeMinOption : modeMaxOption;
  const otherModeOption = presentation.mode === "min" ? modeMaxOption : modeMinOption;
  const expectedKindOption = presentation.kind === "words" ? kindWordsOption : kindMinutesOption;
  const otherKindOption = presentation.kind === "words" ? kindMinutesOption : kindWordsOption;
  return (
    (mutable === "modeSelect" || goalSelectValueIsExact(modeSelect, presentation.mode, expectedModeOption, otherModeOption)) &&
    (mutable === "valueInput" || valueInput.value === presentation.value) &&
    (mutable === "kindSelect" || goalSelectValueIsExact(kindSelect, presentation.kind, expectedKindOption, otherKindOption))
  );
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
  const generation = useMemo<GoalGeneration>(
    () => ({
      presentation,
      form: goalElementSlot(),
      modeSelect: goalElementSlot(),
      valueInput: goalElementSlot(),
      kindSelect: goalElementSlot(),
      setButton: goalElementSlot(),
      clearButton: goalElementSlot(),
    }),
    [presentation],
  );
  const activeGenerationRef = useRef<GoalGeneration | null>(null);
  const claimedGenerationRef = useRef<GoalGeneration | null>(null);
  const activePublicationRef = useRef<GoalPublication | null>(null);
  const { canEdit, kind, mode, value } = presentation;
  const goal = presentation.sharedGoal.goal;
  const progress = presentation.progress.progress;

  function retirePublication(publication: GoalPublication | null) {
    if (!publication || publication.retired) return;
    publication.retired = true;
    if (activePublicationRef.current === publication) activePublicationRef.current = null;
  }

  function retireGenerationPublication(exactGeneration: GoalGeneration) {
    const publication = activePublicationRef.current;
    if (publication?.generation === exactGeneration) retirePublication(publication);
  }

  function publicationForGeneration(exactGeneration: GoalGeneration): GoalPublication | null {
    const form = exactGeneration.form.connection?.element;
    const modeSelect = exactGeneration.modeSelect.connection?.element;
    const valueInput = exactGeneration.valueInput.connection?.element;
    const kindSelect = exactGeneration.kindSelect.connection?.element;
    const setButton = exactGeneration.setButton.connection?.element;
    const clearButton = exactGeneration.clearButton.connection?.element ?? null;
    const ownerWindow = form?.ownerDocument.defaultView;
    const modeMinOption = modeSelect?.children.item(0);
    const modeMaxOption = modeSelect?.children.item(1);
    const kindWordsOption = kindSelect?.children.item(0);
    const kindMinutesOption = kindSelect?.children.item(1);
    const actions = setButton?.parentElement;
    if (
      !canEdit ||
      !form ||
      !modeSelect ||
      !valueInput ||
      !kindSelect ||
      !setButton ||
      (goal ? !clearButton : clearButton !== null) ||
      !ownerWindow ||
      !(modeMinOption instanceof ownerWindow.HTMLOptionElement) ||
      !(modeMaxOption instanceof ownerWindow.HTMLOptionElement) ||
      !(kindWordsOption instanceof ownerWindow.HTMLOptionElement) ||
      !(kindMinutesOption instanceof ownerWindow.HTMLOptionElement) ||
      !(actions instanceof ownerWindow.HTMLSpanElement)
    ) {
      return null;
    }
    const publication: GoalPublication = {
      generation: exactGeneration,
      presentation,
      form,
      modeSelect,
      modeMinOption,
      modeMaxOption,
      valueInput,
      kindSelect,
      kindWordsOption,
      kindMinutesOption,
      actions,
      setButton,
      clearButton,
      claimed: false,
      retired: false,
    };
    return goalPublicationDomIsExact(publication, null) ? publication : null;
  }

  function publishGeneration(exactGeneration: GoalGeneration) {
    if (
      claimedGenerationRef.current === exactGeneration ||
      activeGenerationRef.current !== exactGeneration
    ) {
      return;
    }
    const next = publicationForGeneration(exactGeneration);
    if (!next) return;
    const current = activePublicationRef.current;
    if (
      current &&
      !current.retired &&
      current.generation === exactGeneration &&
      current.form === next.form &&
      current.modeSelect === next.modeSelect &&
      current.valueInput === next.valueInput &&
      current.kindSelect === next.kindSelect &&
      current.setButton === next.setButton &&
      current.clearButton === next.clearButton
    ) {
      return;
    }
    retirePublication(current);
    activePublicationRef.current = next;
  }

  function bindElement<T extends HTMLElement>(
    exactGeneration: GoalGeneration,
    slot: GoalElementSlot<T>,
    element: T | null,
  ) {
    if (!element) {
      if (!slot.connection) return;
      slot.connection = null;
      retireGenerationPublication(exactGeneration);
      return;
    }
    if (slot.expected && slot.expected !== element) return;
    slot.expected ??= element;
    const connection = { element };
    slot.connection = connection;
    retireGenerationPublication(exactGeneration);
    publishGeneration(exactGeneration);
    return () => {
      if (slot.connection !== connection) return;
      slot.connection = null;
      retireGenerationPublication(exactGeneration);
    };
  }

  useLayoutEffect(() => {
    activeGenerationRef.current = generation;
    publishGeneration(generation);
    return () => {
      if (activeGenerationRef.current === generation) activeGenerationRef.current = null;
      retireGenerationPublication(generation);
    };
  });

  function currentPublication(mutable: "modeSelect" | "valueInput" | "kindSelect" | null) {
    const publication = activePublicationRef.current;
    if (
      !publication ||
      publication.retired ||
      publication.claimed ||
      publication.generation !== generation ||
      publication.presentation !== presentation ||
      activeGenerationRef.current !== generation ||
      claimedGenerationRef.current === generation ||
      !goalPresentationIsExact(presentation) ||
      !canEdit ||
      generation.form.connection?.element !== publication.form ||
      generation.modeSelect.connection?.element !== publication.modeSelect ||
      generation.valueInput.connection?.element !== publication.valueInput ||
      generation.kindSelect.connection?.element !== publication.kindSelect ||
      generation.setButton.connection?.element !== publication.setButton ||
      (publication.clearButton
        ? generation.clearButton.connection?.element !== publication.clearButton
        : generation.clearButton.connection !== null) ||
      !goalPublicationDomIsExact(publication, mutable)
    ) {
      return null;
    }
    return publication;
  }

  function claimEvent(publication: GoalPublication, nativeEvent: Event) {
    if (
      activePublicationRef.current !== publication ||
      publication.retired ||
      publication.claimed ||
      claimedGenerationRef.current === publication.generation ||
      claimedGoalNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    publication.claimed = true;
    claimedGenerationRef.current = publication.generation;
    claimedGoalNativeEvents.add(nativeEvent);
    return true;
  }

  function exactChangeEvent<T extends HTMLSelectElement | HTMLInputElement>(
    event: React.ChangeEvent<T>,
    control: T,
    type: "change" | "input",
  ): Event | null {
    const nativeEvent = event.nativeEvent;
    const ownerWindow = control.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      event.currentTarget !== control ||
      event.target !== control ||
      event.defaultPrevented ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent.type !== type ||
      nativeEvent.target !== control ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    return nativeEvent;
  }

  function changeMode(event: React.ChangeEvent<HTMLSelectElement>) {
    const publication = currentPublication("modeSelect");
    if (!publication) return;
    const nativeEvent = exactChangeEvent(event, publication.modeSelect, "change");
    const next = publication.modeSelect.value;
    const selected = next === "min" ? publication.modeMinOption : publication.modeMaxOption;
    const other = next === "min" ? publication.modeMaxOption : publication.modeMinOption;
    if (
      !nativeEvent ||
      !isGoalMode(next) ||
      !goalSelectValueIsExact(publication.modeSelect, next, selected, other) ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
    setDraft({ ...presentation.draft, mode: next });
  }

  function changeValue(event: React.ChangeEvent<HTMLInputElement>) {
    const publication = currentPublication("valueInput");
    if (!publication) return;
    const nativeEvent = exactChangeEvent(event, publication.valueInput, "input");
    if (!nativeEvent || !claimEvent(publication, nativeEvent)) return;
    const next = publication.valueInput.value;
    setDraft({ ...presentation.draft, value: next });
  }

  function changeKind(event: React.ChangeEvent<HTMLSelectElement>) {
    const publication = currentPublication("kindSelect");
    if (!publication) return;
    const nativeEvent = exactChangeEvent(event, publication.kindSelect, "change");
    const next = publication.kindSelect.value;
    const selected = next === "words" ? publication.kindWordsOption : publication.kindMinutesOption;
    const other = next === "words" ? publication.kindMinutesOption : publication.kindWordsOption;
    if (
      !nativeEvent ||
      !isGoalKind(next) ||
      !goalSelectValueIsExact(publication.kindSelect, next, selected, other) ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
    setDraft({ ...presentation.draft, kind: next });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    const publication = currentPublication(null);
    if (!publication) return;
    const nativeEvent = event.nativeEvent;
    const ownerWindow = publication.form.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      event.currentTarget !== publication.form ||
      event.target !== publication.form ||
      event.defaultPrevented ||
      !(nativeEvent instanceof ownerWindow.SubmitEvent) ||
      nativeEvent.type !== "submit" ||
      nativeEvent.target !== publication.form ||
      nativeEvent.defaultPrevented ||
      !nativeEvent.bubbles ||
      !nativeEvent.cancelable ||
      (nativeEvent.submitter !== null && nativeEvent.submitter !== publication.setButton) ||
      publication.setButton.disabled ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
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
    const publication = currentPublication(null);
    const clearButton = publication?.clearButton;
    if (!publication || !clearButton) return;
    const nativeEvent = event.nativeEvent;
    const ownerWindow = clearButton.ownerDocument.defaultView;
    const target = event.target;
    if (
      !presentation.sharedGoal.goal ||
      !ownerWindow ||
      event.currentTarget !== clearButton ||
      event.defaultPrevented ||
      !(target instanceof ownerWindow.Node) ||
      !clearButton.contains(target) ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.target !== target ||
      nativeEvent.defaultPrevented ||
      !nativeEvent.bubbles ||
      !nativeEvent.cancelable ||
      clearButton.disabled ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
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
        <form ref={(element) => bindElement(generation, generation.form, element)} className="mt-2 flex flex-wrap items-center gap-1.5" onSubmit={submit}>
          <select
            ref={(element) => bindElement(generation, generation.modeSelect, element)}
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
            ref={(element) => bindElement(generation, generation.valueInput, element)}
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
            ref={(element) => bindElement(generation, generation.kindSelect, element)}
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
            <button ref={(element) => bindElement(generation, generation.setButton, element)} type="submit" className="btn btn-primary btn-sm h-8" disabled={presentation.setDisabled} data-testid="goal-set">
              Set
            </button>
            {goal && (
              <button ref={(element) => bindElement(generation, generation.clearButton, element)} type="button" className="btn btn-ghost btn-sm h-8" onClick={clear} data-testid="goal-clear">
                Clear
              </button>
            )}
          </span>
        </form>
      )}
    </div>
  );
}
