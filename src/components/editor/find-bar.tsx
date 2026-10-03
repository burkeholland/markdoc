"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Replace, WholeWord, X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { compileFindRegex, type FindMatch, type FindOptions } from "@/editor/find";
import { Tip } from "@/components/ui/primitives";
import { cn, findReplaceShortcut, shortcut } from "@/lib/utils";
import { useEnterOnRelease } from "./press-once";
import { shallowEqual, useSessionValue } from "./use-session";

export interface FindBarProps {
  session: CollabSession;
  /** Whether the replace row is shown. */
  replaceVisible: boolean;
  onReplaceVisible: (visible: boolean) => void;
  /** Bumped by the shell whenever the bar should take focus (Mod-F while already open). */
  focusNonce: number;
  /** Called after the active match changes so the shell can scroll it into view. */
  onReveal: (match: FindMatch) => void;
  /**
   * Called when the bar wants to close (Escape or the close button). `click` is the pointer click on the
   * close button when that is what closed it, so the shell can hold the button's place for the rest of a
   * double-click; a close from the keyboard has none.
   */
  onClose: (click?: ReactMouseEvent<HTMLButtonElement>) => void;
}

/** One session's use of the bar. Work started for an old session never touches a new one. */
interface FindBarVisit {
  session: CollabSession;
}

interface ReplacementDraft {
  visit: FindBarVisit;
  value: string;
}

/**
 * Where an arrow, Home or End key moves focus in the first row's action buttons. Bounded and never
 * wrapping: a missing neighbour, or Home/End on the element already there, does nothing.
 */
function actionDestination(key: string, index: number, length: number): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return index > 0 ? index - 1 : null;
    case "ArrowRight":
    case "ArrowDown":
      return index + 1 < length ? index + 1 : null;
    case "Home":
      return index === 0 ? null : 0;
    case "End":
      return index === length - 1 ? null : length - 1;
    default:
      return null;
  }
}

/** The code pane (CodeMirror) and the rich pane (ProseMirror), where F3 also steps. */
const EDITOR_PANES = ".cm-editor, .md-rich";

/** Mouse down on these controls keeps focus (and the caret) in the find input. */
const keepInputFocus = (e: ReactMouseEvent) => e.preventDefault();

/** A press on the bar itself (padding, a gap between buttons, the counter) leaves focus where it is. */
const keepFocusOnBackground = (e: ReactMouseEvent) => {
  if (!(e.target as Element).closest("input, button")) e.preventDefault();
};

/**
 * Step and replace buttons with nothing to act on are `aria-disabled`, not `disabled`: a disabled button
 * drops focus to the page when it switches off while it has focus (Replace on the last match), and the
 * rest of a double-click would fall through it. Pressing one does nothing: the session has no match.
 */
const OFF_ICON = "aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-2";
const OFF_BUTTON = "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-surface";

function OptionToggle({
  label,
  active,
  onClick,
  testId,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        className="icon-btn h-7 w-7 rounded-md"
        data-active={active ? "true" : undefined}
        aria-pressed={active}
        aria-label={label}
        onMouseDown={keepInputFocus}
        onClick={onClick}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

export function FindBar({ session, replaceVisible, onReplaceVisible, focusNonce, onReveal, onClose }: FindBarProps) {
  const visit = useMemo<FindBarVisit>(() => ({ session }), [session]);
  const { find, canEdit, total, active } = useSessionValue(
    session,
    (s) => ({
      find: s.find,
      canEdit: s.canEdit,
      total: s.find?.matches.length ?? 0,
      active: s.find?.active ?? -1,
    }),
    shallowEqual,
  );
  const [replacementDraft, setReplacementDraft] = useState<ReplacementDraft>(() => ({ visit, value: "" }));
  const barRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceRowRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const toggleReplaceRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeVisit = useRef<FindBarVisit | null>(null);
  const replaceFocusIntent = useRef<FindBarVisit | null>(null);
  const replacement = replacementDraft.visit === visit ? replacementDraft.value : "";
  // The session tells its subscribers in a microtask, and the find field shows the session's query. The
  // field needs its new value in the same event: React puts the old one back first otherwise, which
  // throws the caret to the end and breaks an IME composition. This render reads the session again.
  const [, renderNow] = useReducer((n: number) => n + 1, 0);
  const enterOnRelease = useEnterOnRelease();

  const ownsVisit = useCallback((owner: FindBarVisit) => activeVisit.current === owner, []);
  const retireVisit = useCallback((owner: FindBarVisit) => {
    if (activeVisit.current === owner) activeVisit.current = null;
    if (replaceFocusIntent.current === owner) replaceFocusIntent.current = null;
  }, []);

  useLayoutEffect(() => {
    activeVisit.current = visit;
    return () => retireVisit(visit);
  }, [retireVisit, visit]);

  useLayoutEffect(() => {
    if (!ownsVisit(visit)) return;
    const input = searchRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusNonce, ownsVisit, visit]);

  const query = find?.query ?? "";
  const options = find?.options;
  const invalidRegex = options ? compileFindRegex(query, options).invalid : false;
  const showReplace = replaceVisible && canEdit;
  const noMatches = total === 0;
  const actionsDisabled = invalidRegex || noMatches;

  // Opening the replace row from the toggle moves focus into it once the row exists.
  useLayoutEffect(() => {
    if (replaceFocusIntent.current !== visit) return;
    if (!showReplace) return;
    replaceFocusIntent.current = null;
    if (ownsVisit(visit)) replaceRef.current?.focus();
  }, [ownsVisit, showReplace, visit]);

  const update = useCallback(
    (nextQuery: string, nextOptions?: FindOptions) => {
      if (!ownsVisit(visit)) return;
      session.setFind(nextQuery, nextOptions);
      renderNow();
      if (!ownsVisit(visit)) return;
      const m = session.find?.matches[session.find.active];
      if (m) onReveal(m);
    },
    [ownsVisit, visit, session, onReveal],
  );

  const toggle = (key: keyof FindOptions) => {
    if (!options) return;
    update(query, { ...options, [key]: !options[key] });
  };

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!ownsVisit(visit)) return;
      const m = session.stepFind(dir);
      if (m && ownsVisit(visit)) onReveal(m);
    },
    [ownsVisit, visit, session, onReveal],
  );

  const replaceOne = () => {
    if (!ownsVisit(visit)) return;
    const m = session.replaceActive(replacement);
    if (m && ownsVisit(visit)) onReveal(m);
  };

  const replaceAll = () => {
    if (!ownsVisit(visit)) return;
    session.replaceAll(replacement);
  };

  const close = (click?: ReactMouseEvent<HTMLButtonElement>) => {
    if (!ownsVisit(visit)) return;
    retireVisit(visit);
    // A click made with the keyboard (or by assistive technology) has no pointer and `detail` 0.
    onClose(click && click.detail > 0 ? click : undefined);
  };

  const toggleReplace = () => {
    if (!ownsVisit(visit)) return;
    const nextVisible = !replaceVisible;
    replaceFocusIntent.current = nextVisible ? visit : null;
    // Hiding the row removes whatever has focus inside it; the find input takes it instead of the page.
    if (!nextVisible && replaceRowRef.current?.contains(document.activeElement)) searchRef.current?.focus();
    onReplaceVisible(nextVisible);
  };

  // F3 / Shift+F3 step through matches while the bar is open, from the bar or from the editor panes.
  // This one listener is the only F3 handler, so each press steps exactly once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F3" || e.defaultPrevented || e.isComposing) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const inBar = !!target && !!barRef.current?.contains(target);
      if (!inBar && !target?.closest(EDITOR_PANES)) return;
      e.preventDefault();
      if (!actionsDisabled) step(e.shiftKey ? -1 : 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actionsDisabled, step]);

  const onBarKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const onActionsKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const group = [prevRef.current, nextRef.current, toggleReplaceRef.current, closeRef.current].filter(
      (button): button is HTMLButtonElement => !!button,
    );
    const index = group.indexOf(e.target as HTMLButtonElement);
    if (index < 0) return;
    const destination = actionDestination(e.key, index, group.length);
    if (destination === null) return;
    e.preventDefault();
    group[destination].focus({ preventScroll: true });
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!invalidRegex) step(e.shiftKey ? -1 : 1);
  };

  const onReplaceKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (invalidRegex) return;
    if (e.shiftKey) step(-1);
    // One press replaces one match: a held Enter does not run through the document.
    else if (!e.repeat) replaceOne();
  };

  if (!find || !options) return null;

  const counter = query ? `${total === 0 ? 0 : active + 1} of ${total}` : "";
  // Room for "<total> of <total>", so the buttons after the counter do not move under the pointer when
  // the active match gains or loses a digit (72 px holds every count below 100 of 100).
  const counterWidth = `max(72px, calc(${2 * String(total).length + 3}ch + 0.5rem))`;

  return (
    <div
      ref={barRef}
      className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface-2 px-3 py-1.5 text-[13px]"
      role="search"
      aria-label="Find and replace"
      data-testid="find-bar"
      onKeyDown={onBarKeyDown}
      onMouseDown={keepFocusOnBackground}
    >
      <div className="flex items-start gap-1.5" data-testid="find-actions" onKeyDown={onActionsKeyDown}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" data-testid="find-row">
        <div className="flex h-8 min-w-[9rem] flex-1 items-center gap-0.5 rounded-lg md:w-[min(420px,40vw)] md:flex-none border border-line-2 bg-surface pl-2.5 pr-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <input
            ref={searchRef}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            placeholder="Find"
            value={query}
            onChange={(e) => update(e.target.value, options)}
            onKeyDown={onSearchKeyDown}
            spellCheck={false}
            autoComplete="off"
            aria-label="Find"
            aria-invalid={invalidRegex}
            aria-describedby={invalidRegex ? "find-regex-error" : undefined}
            data-testid="find-input"
          />
          <OptionToggle label="Match case" active={options.matchCase} onClick={() => toggle("matchCase")} testId="find-match-case">
            <CaseSensitive size={15} />
          </OptionToggle>
          <OptionToggle label="Whole word" active={options.wholeWord} onClick={() => toggle("wholeWord")} testId="find-whole-word">
            <WholeWord size={15} />
          </OptionToggle>
          <OptionToggle label="Regular expression" active={options.regex} onClick={() => toggle("regex")} testId="find-regex">
            <Regex size={15} />
          </OptionToggle>
        </div>
        {invalidRegex ? (
          <span id="find-regex-error" className="min-w-[72px] whitespace-nowrap px-1 text-danger" role="status" data-testid="find-regex-error">
            Invalid regular expression
          </span>
        ) : (
          <span
            className={cn("px-1 tabular-nums", noMatches && query ? "text-danger" : "text-ink-3")}
            style={{ minWidth: counterWidth }}
            aria-live="polite"
            data-testid="find-count"
          >
            {counter}
          </span>
        )}
        <Tip label="Previous match" shortcut={shortcut("Shift-Enter")}>
          <button
            ref={prevRef}
            type="button"
            className={cn("icon-btn h-7 w-7 rounded-md", OFF_ICON)}
            aria-disabled={actionsDisabled || undefined}
            onMouseDown={keepInputFocus}
            onClick={() => step(-1)}
            aria-label="Previous match"
            data-testid="find-prev"
          >
            <ChevronUp size={16} />
          </button>
        </Tip>
        <Tip label="Next match" shortcut="Enter">
          <button
            ref={nextRef}
            type="button"
            className={cn("icon-btn h-7 w-7 rounded-md", OFF_ICON)}
            aria-disabled={actionsDisabled || undefined}
            onMouseDown={keepInputFocus}
            onClick={() => step(1)}
            aria-label="Next match"
            data-testid="find-next"
          >
            <ChevronDown size={16} />
          </button>
        </Tip>
        {canEdit && (
          <Tip label={replaceVisible ? "Hide replace" : "Replace"} shortcut={replaceVisible ? undefined : shortcut(findReplaceShortcut())}>
            <button
              ref={toggleReplaceRef}
              type="button"
              className={cn("btn btn-ghost h-8 shrink-0 gap-1.5 px-2 text-[13px]", replaceVisible && "bg-surface-3 text-ink")}
              onMouseDown={keepInputFocus}
              onClick={toggleReplace}
              aria-expanded={replaceVisible}
              aria-controls="find-replace-row"
              data-testid="find-toggle-replace"
            >
              <Replace size={15} aria-hidden="true" />
              {/* Icon only below 640 px so the row keeps its one-line shape on phones. From 640 px the
                  label keeps the width of the longer text (the hidden `after`), so the button does not
                  shrink under the pointer between the two clicks of a double-click. */}
              <span className="sr-only sm:not-sr-only sm:inline-grid sm:after:invisible sm:after:col-start-1 sm:after:row-start-1 sm:after:content-['Hide_replace']">
                <span className="col-start-1 row-start-1 text-left">{replaceVisible ? "Hide replace" : "Replace"}</span>
              </span>
            </button>
          </Tip>
        )}
        <div className="flex-1" />
        </div>
        {/* Outside the wrapping row so it stays pinned top-right when the controls wrap on phones. */}
        <Tip label="Close" shortcut="Esc">
          <button
            ref={closeRef}
            type="button"
            className="icon-btn mt-0.5 h-7 w-7 shrink-0 rounded-md"
            // Enter closes on release: the bar hands focus to the editor, where a held Enter would type.
            {...enterOnRelease}
            onClick={close}
            aria-label="Close find"
            data-testid="find-close"
          >
            <X size={15} />
          </button>
        </Tip>
      </div>
      {showReplace && (
        <div ref={replaceRowRef} id="find-replace-row" className="flex flex-wrap items-center gap-1.5" data-testid="find-replace-row">
          <div className="min-w-[9rem] flex-1 md:w-[min(420px,40vw)] md:flex-none">
            <input
              ref={replaceRef}
              className="input h-8 text-[13px]"
              placeholder="Replace with"
              value={replacement}
              onChange={(e) => {
                if (ownsVisit(visit)) setReplacementDraft({ visit, value: e.target.value });
              }}
              onKeyDown={onReplaceKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label="Replace with"
              data-testid="replace-input"
            />
          </div>
          {/* Enter replaces on release, once per press, as Space does. */}
          <button
            type="button"
            className={cn("btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]", OFF_BUTTON)}
            aria-disabled={actionsDisabled || undefined}
            {...enterOnRelease}
            onClick={replaceOne}
            data-testid="replace-one"
          >
            Replace
          </button>
          <button
            type="button"
            className={cn("btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]", OFF_BUTTON)}
            aria-disabled={actionsDisabled || undefined}
            {...enterOnRelease}
            onClick={replaceAll}
            data-testid="replace-all"
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
