"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { FindMatch, FindOptions } from "@/editor/find";
import { Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
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
  const find = useSessionValue(session, (s) => s.find);
  const { canEdit, total, active } = useSessionValue(
    session,
    (s) => ({ canEdit: s.canEdit, total: s.find?.matches.length ?? 0, active: s.find?.active ?? -1 }),
    shallowEqual,
  );
  const [replacement, setReplacement] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = searchRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusNonce]);

  const query = find?.query ?? "";
  const options = find?.options;

  const update = useCallback(
    (nextQuery: string, nextOptions?: FindOptions) => {
      session.setFind(nextQuery, nextOptions);
      const m = session.find?.matches[session.find.active];
      if (m) onReveal(m);
    },
    [session, onReveal],
  );

  const toggle = (key: keyof FindOptions) => {
    if (!options) return;
    update(query, { ...options, [key]: !options[key] });
  };

  const step = useCallback(
    (dir: 1 | -1) => {
      const m = session.stepFind(dir);
      if (m) onReveal(m);
    },
    [session, onReveal],
  );

  const replaceOne = useCallback(() => {
    const m = session.replaceActive(replacement);
    if (m) onReveal(m);
  }, [session, replacement, onReveal]);

  const replaceAll = useCallback(() => {
    session.replaceAll(replacement);
  }, [session, replacement]);

  const onBarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) step(-1);
      else replaceOne();
    }
  };

  if (!find || !options) return null;

  const counter = query ? `${total === 0 ? 0 : active + 1} of ${total}` : "";
  const noMatches = total === 0;
  const showReplace = replaceVisible && canEdit;

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
        <span className={cn("min-w-[72px] px-1 tabular-nums", noMatches && query ? "text-danger" : "text-ink-3")} aria-live="polite" data-testid="find-count">
          {counter}
        </span>
        <Tip label="Previous match" shortcut={shortcut("Shift-Enter")}>
          <button type="button" className="icon-btn h-7 w-7 rounded-md" disabled={noMatches} onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)} aria-label="Previous match" data-testid="find-prev">
            <ChevronUp size={16} />
          </button>
        </Tip>
        <Tip label="Next match" shortcut="Enter">
          <button type="button" className="icon-btn h-7 w-7 rounded-md" disabled={noMatches} onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)} aria-label="Next match" data-testid="find-next">
            <ChevronDown size={16} />
          </button>
        </Tip>
        {canEdit && (
          <button
            type="button"
            className={cn("btn btn-ghost h-8 shrink-0 px-2 text-[13px]", replaceVisible && "bg-surface-3 text-ink")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onReplaceVisible(!replaceVisible);
              if (!replaceVisible) requestAnimationFrame(() => replaceRef.current?.focus());
            }}
            aria-expanded={replaceVisible}
            data-testid="find-toggle-replace"
          >
            Replace
          </button>
        )}
        <div className="flex-1" />
        </div>
        {/* Outside the wrapping row so it stays pinned top-right when the controls wrap on phones. */}
        <Tip label="Close" shortcut="Esc">
          <button type="button" className="icon-btn mt-0.5 h-7 w-7 shrink-0 rounded-md" onClick={onClose} aria-label="Close find" data-testid="find-close">
            <X size={15} />
          </button>
        </Tip>
      </div>
      {showReplace && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="find-replace-row">
          <div className="min-w-[9rem] flex-1 md:w-[min(420px,40vw)] md:flex-none">
            <input
              ref={replaceRef}
              className="input h-8 text-[13px]"
              placeholder="Replace with"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={onReplaceKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label="Replace with"
              data-testid="replace-input"
            />
          </div>
          <button type="button" className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]" disabled={noMatches} onClick={replaceOne} data-testid="replace-one">
            Replace
          </button>
          <button type="button" className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]" disabled={noMatches} onClick={replaceAll} data-testid="replace-all">
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
