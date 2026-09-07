"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Replace, WholeWord, X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { compileFindRegex, type FindMatch, type FindOptions } from "@/editor/find";
import { Tip } from "@/components/ui/primitives";
import { cn, findReplaceShortcut, shortcut } from "@/lib/utils";
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
  /** Called when the bar wants to close (Escape or the close button). */
  onClose: () => void;
}

interface FindBarVisit {
  session: CollabSession;
}

interface ReplacementDraft {
  visit: FindBarVisit;
  value: string;
}

interface ReplaceFocusOwner {
  visit: FindBarVisit;
  frame: number;
}

function OptionToggle({ label, active, onClick, testId, children }: { label: string; active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        className="icon-btn h-7 w-7 rounded-md"
        data-active={active ? "true" : undefined}
        aria-pressed={active}
        aria-label={label}
        onMouseDown={(e) => e.preventDefault()}
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
  const find = useSessionValue(session, (s) => s.find);
  const { canEdit, total, active } = useSessionValue(
    session,
    (s) => ({ canEdit: s.canEdit, total: s.find?.matches.length ?? 0, active: s.find?.active ?? -1 }),
    shallowEqual,
  );
  const [replacementDraft, setReplacementDraft] = useState<ReplacementDraft>(() => ({ visit, value: "" }));
  const searchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const activeVisit = useRef<FindBarVisit | null>(null);
  const replaceFocusOwner = useRef<ReplaceFocusOwner | null>(null);
  const replacement = replacementDraft.visit === visit ? replacementDraft.value : "";

  const ownsVisit = useCallback((owner: FindBarVisit) => activeVisit.current === owner, []);
  const cancelReplaceFocus = useCallback((owner: FindBarVisit) => {
    const focusOwner = replaceFocusOwner.current;
    if (focusOwner?.visit !== owner) return;
    replaceFocusOwner.current = null;
    cancelAnimationFrame(focusOwner.frame);
  }, []);
  const retireVisit = useCallback((owner: FindBarVisit) => {
    if (activeVisit.current === owner) activeVisit.current = null;
    cancelReplaceFocus(owner);
  }, [cancelReplaceFocus]);

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

  useLayoutEffect(() => {
    if (!showReplace) cancelReplaceFocus(visit);
  }, [cancelReplaceFocus, showReplace, visit]);

  const update = useCallback(
    (nextQuery: string, nextOptions?: FindOptions) => {
      if (!ownsVisit(visit)) return;
      session.setFind(nextQuery, nextOptions);
      if (!ownsVisit(visit)) return;
      const m = session.find?.matches[session.find.active];
      if (m) onReveal(m);
    },
    [ownsVisit, visit, session, onReveal],
  );

  const toggle = (key: keyof FindOptions) => {
    if (!ownsVisit(visit) || !options) return;
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

  const replaceOne = useCallback(() => {
    if (!ownsVisit(visit)) return;
    const m = session.replaceActive(replacement);
    if (m && ownsVisit(visit)) onReveal(m);
  }, [ownsVisit, visit, session, replacement, onReveal]);

  const replaceAll = useCallback(() => {
    if (!ownsVisit(visit)) return;
    session.replaceAll(replacement);
  }, [ownsVisit, visit, session, replacement]);

  const close = useCallback(() => {
    if (!ownsVisit(visit)) return;
    retireVisit(visit);
    onClose();
  }, [ownsVisit, retireVisit, visit, onClose]);

  const toggleReplace = () => {
    if (!ownsVisit(visit)) return;
    const nextVisible = !replaceVisible;
    if (!nextVisible) cancelReplaceFocus(visit);
    onReplaceVisible(nextVisible);
    if (!nextVisible || !ownsVisit(visit)) return;

    cancelReplaceFocus(visit);
    const focusOwner: ReplaceFocusOwner = { visit, frame: -1 };
    const frame = requestAnimationFrame(() => {
      if (!ownsVisit(visit) || replaceFocusOwner.current !== focusOwner || focusOwner.frame !== frame) return;
      replaceFocusOwner.current = null;
      replaceRef.current?.focus();
    });
    focusOwner.frame = frame;
    replaceFocusOwner.current = focusOwner;
  };

  const onBarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && ownsVisit(visit)) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && ownsVisit(visit)) {
      e.preventDefault();
      if (!invalidRegex) step(e.shiftKey ? -1 : 1);
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && ownsVisit(visit)) {
      e.preventDefault();
      if (invalidRegex) return;
      if (e.shiftKey) step(-1);
      else replaceOne();
    }
  };

  if (!find || !options) return null;

  const counter = query ? `${total === 0 ? 0 : active + 1} of ${total}` : "";
  const noMatches = total === 0;
  const actionsDisabled = invalidRegex || noMatches;

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface-2 px-3 py-1.5 text-[13px]"
      role="search"
      aria-label="Find and replace"
      data-testid="find-bar"
      onKeyDown={onBarKeyDown}
    >
      <div className="flex items-start gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" data-testid="find-row">
        <div className="flex h-8 min-w-[9rem] flex-1 items-center gap-0.5 rounded-lg md:w-[min(420px,40vw)] md:flex-none border border-line-2 bg-surface pl-2.5 pr-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <input
            ref={searchRef}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            placeholder="Find"
            value={query}
            onChange={(e) => update(e.target.value)}
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
          <span className={cn("min-w-[72px] px-1 tabular-nums", noMatches && query ? "text-danger" : "text-ink-3")} aria-live="polite" data-testid="find-count">
            {counter}
          </span>
        )}
        <Tip label="Previous match" shortcut={shortcut("Shift-Enter")}>
          <button type="button" className="icon-btn h-7 w-7 rounded-md" disabled={actionsDisabled} onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)} aria-label="Previous match" data-testid="find-prev">
            <ChevronUp size={16} />
          </button>
        </Tip>
        <Tip label="Next match" shortcut="Enter">
          <button type="button" className="icon-btn h-7 w-7 rounded-md" disabled={actionsDisabled} onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)} aria-label="Next match" data-testid="find-next">
            <ChevronDown size={16} />
          </button>
        </Tip>
        {canEdit && (
          <Tip label={replaceVisible ? "Hide replace" : "Replace"} shortcut={replaceVisible ? undefined : shortcut(findReplaceShortcut())}>
            <button
              type="button"
              className={cn("btn btn-ghost h-8 shrink-0 gap-1.5 px-2 text-[13px]", replaceVisible && "bg-surface-3 text-ink")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleReplace}
              aria-expanded={replaceVisible}
              aria-controls="find-replace-row"
              data-testid="find-toggle-replace"
            >
              <Replace size={15} aria-hidden="true" />
              {/* Icon only below 640 px so the row keeps its one-line shape on phones. */}
              <span className="sr-only sm:not-sr-only">{replaceVisible ? "Hide replace" : "Replace"}</span>
            </button>
          </Tip>
        )}
        <div className="flex-1" />
        </div>
        {/* Outside the wrapping row so it stays pinned top-right when the controls wrap on phones. */}
        <Tip label="Close" shortcut="Esc">
          <button type="button" className="icon-btn mt-0.5 h-7 w-7 shrink-0 rounded-md" onClick={close} aria-label="Close find" data-testid="find-close">
            <X size={15} />
          </button>
        </Tip>
      </div>
      {showReplace && (
        <div id="find-replace-row" className="flex flex-wrap items-center gap-1.5" data-testid="find-replace-row">
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
          <button type="button" className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]" disabled={actionsDisabled} onClick={replaceOne} data-testid="replace-one">
            Replace
          </button>
          <button type="button" className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]" disabled={actionsDisabled} onClick={replaceAll} data-testid="replace-all">
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
