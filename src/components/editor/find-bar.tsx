"use client";

import {
  useLayoutEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Replace, WholeWord, X } from "lucide-react";
import type { CollabSession, FindState } from "@/editor/collab/session";
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

type FindInput = "search" | "replace";
type FindControl =
  | "matchCase"
  | "wholeWord"
  | "regex"
  | "previous"
  | "next"
  | "toggleReplace"
  | "close"
  | "replaceOne"
  | "replaceAll";

interface FindBarVisit {
  readonly mount: symbol;
  readonly session: CollabSession;
}

interface SearchFocusRequest {
  readonly visit: FindBarVisit;
  readonly focusNonce: number;
}

interface ReplacementDraft {
  readonly visit: FindBarVisit;
  readonly value: string;
}

interface FindBarMethods {
  readonly setFind: CollabSession["setFind"];
  readonly stepFind: CollabSession["stepFind"];
  readonly replaceActive: CollabSession["replaceActive"];
  readonly replaceAll: CollabSession["replaceAll"];
}

interface FindBarAuthority {
  readonly visit: FindBarVisit;
  readonly session: CollabSession;
  readonly find: FindState;
  readonly options: FindOptions;
  readonly optionValues: Readonly<FindOptions>;
  readonly matches: FindMatch[];
  readonly query: string;
  readonly replacement: string;
  readonly canEdit: boolean;
  readonly total: number;
  readonly active: number;
  readonly replaceVisible: boolean;
  readonly showReplace: boolean;
  readonly focusNonce: number;
  readonly focusRequest: SearchFocusRequest;
  readonly invalidRegex: boolean;
  readonly noMatches: boolean;
  readonly actionsDisabled: boolean;
  readonly methods: FindBarMethods;
  readonly onReplaceVisible: (visible: boolean) => void;
  readonly onReveal: (match: FindMatch) => void;
  readonly onClose: () => void;
}

class CurrentCell<T> {
  constructor(public current: T) {}
}

class ElementOwner<T extends HTMLElement> {
  private current: T | null = null;
  private lastElement: T | null = null;

  constructor(
    private readonly onReplacement: () => void,
    private readonly retireOnDetach = true,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const replaced = element !== null && this.lastElement !== null && this.lastElement !== element;
    this.current = element;
    if (element) this.lastElement = element;
    if (replaced || (element === null && this.retireOnDetach)) this.onReplacement();
  };
}

interface FindInputPublication {
  readonly capture: (element: HTMLInputElement | null) => void;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

interface FindControlPublication {
  readonly id: FindControl;
  readonly enabled: boolean;
  readonly capture: (element: HTMLButtonElement | null) => void;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onMouseDown?: (event: MouseEvent<HTMLButtonElement>) => void;
}

interface FindBarPublication {
  readonly authority: FindBarAuthority;
  readonly captureBar: (element: HTMLDivElement | null) => void;
  readonly inputs: Readonly<Record<FindInput, FindInputPublication>>;
  readonly controls: Readonly<Record<FindControl, FindControlPublication>>;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly ownsInput: (kind: FindInput, element: HTMLInputElement) => boolean;
  readonly focusSearch: () => boolean;
  readonly scheduleReplaceFocus: () => boolean;
  readonly onBarKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

interface ReplaceFocusIntent {
  readonly source: FindBarPublication;
}

interface ReplaceFocusOwner {
  readonly publication: FindBarPublication;
  readonly element: HTMLInputElement;
  frame: number | null;
}

interface PublicationCells {
  readonly active: CurrentCell<FindBarPublication | null>;
  readonly focusRequest: CurrentCell<SearchFocusRequest | null>;
  readonly replaceIntent: CurrentCell<ReplaceFocusIntent | null>;
  readonly replaceFocus: CurrentCell<ReplaceFocusOwner | null>;
  readonly claimedActivations: WeakSet<object>;
  readonly claimedMouseDowns: WeakSet<object>;
}

interface PublicationLifecycle {
  readonly establish: () => void;
  readonly retire: () => void;
}

function createInactivePublication(cells: PublicationCells): PublicationLifecycle {
  return Object.freeze({
    establish: () => {
      cells.active.current?.retire();
      cells.replaceIntent.current = null;
    },
    retire: () => {},
  });
}

function isExactReplaceSuccessor(source: FindBarPublication, candidate: FindBarPublication) {
  const previous = source.authority;
  const current = candidate.authority;
  return (
    !previous.replaceVisible &&
    current.replaceVisible &&
    current.showReplace &&
    previous.visit === current.visit &&
    previous.session === current.session &&
    previous.find === current.find &&
    previous.options === current.options &&
    previous.matches === current.matches &&
    previous.query === current.query &&
    previous.replacement === current.replacement &&
    previous.canEdit === current.canEdit &&
    previous.total === current.total &&
    previous.active === current.active &&
    previous.focusNonce === current.focusNonce &&
    previous.methods.setFind === current.methods.setFind &&
    previous.methods.stepFind === current.methods.stepFind &&
    previous.methods.replaceActive === current.methods.replaceActive &&
    previous.methods.replaceAll === current.methods.replaceAll &&
    previous.onReplaceVisible === current.onReplaceVisible &&
    previous.onReveal === current.onReveal &&
    previous.onClose === current.onClose
  );
}

function createFindBarPublication({
  authority,
  cells,
  setReplacementDraft,
}: {
  authority: FindBarAuthority;
  cells: PublicationCells;
  setReplacementDraft: Dispatch<SetStateAction<ReplacementDraft>>;
}): FindBarPublication {
  const retireOnReplacement = () => publication?.retire();
  const bar = new ElementOwner<HTMLDivElement>(retireOnReplacement);
  const searchOwner = new ElementOwner<HTMLInputElement>(retireOnReplacement);
  const replaceOwner = new ElementOwner<HTMLInputElement>(retireOnReplacement);

  const factsAreCurrent = () => {
    const current = authority.session.find;
    const values = authority.optionValues;
    return (
      current === authority.find &&
      current.options === authority.options &&
      current.matches === authority.matches &&
      current.query === authority.query &&
      current.matches.length === authority.total &&
      current.active === authority.active &&
      current.options.matchCase === values.matchCase &&
      current.options.wholeWord === values.wholeWord &&
      current.options.regex === values.regex &&
      authority.session.canEdit === authority.canEdit
    );
  };
  const ownsIdentity = () =>
    cells.active.current === publication &&
    publication.authority.visit.mount === authority.visit.mount;
  const ownsAuthority = () => ownsIdentity() && factsAreCurrent() && exactDomIsCurrent();
  const ownsBar = (element: HTMLDivElement) => {
    const owned = bar.element();
    return (
      ownsAuthority() &&
      owned === element &&
      element.isConnected
    );
  };
  const inputOwner = (kind: FindInput) => kind === "search" ? searchOwner : replaceOwner;
  const ownsInput = (kind: FindInput, element: HTMLInputElement) => {
    const root = bar.element();
    return (
      ownsAuthority() &&
      inputOwner(kind).element() === element &&
      !!root &&
      root.isConnected &&
      element.isConnected &&
      root.contains(element)
    );
  };
  const claim = (event: object) => {
    if (cells.claimedActivations.has(event)) return false;
    cells.claimedActivations.add(event);
    return true;
  };
  const stillOwnsActivation = () => ownsIdentity();
  const reveal = (match: FindMatch | null) => {
    if (match && stillOwnsActivation()) authority.onReveal(match);
  };
  const update = (nextQuery: string, nextOptions: FindOptions) => {
    authority.methods.setFind.call(authority.session, nextQuery, nextOptions);
    const result = authority.session.find;
    if (
      !stillOwnsActivation() ||
      !result ||
      result === authority.find ||
      result.query !== nextQuery ||
      result.options !== nextOptions
    ) return;
    reveal(result.matches[result.active] ?? null);
  };
  const step = (direction: 1 | -1) => {
    const match = authority.methods.stepFind.call(authority.session, direction);
    reveal(match);
  };
  const replaceOne = () => {
    const match = authority.methods.replaceActive.call(authority.session, authority.replacement);
    reveal(match);
  };
  const replaceAll = () => {
    authority.methods.replaceAll.call(authority.session, authority.replacement);
  };
  const cancelReplaceFocus = () => {
    const owner = cells.replaceFocus.current;
    if (owner?.publication !== publication) return;
    cells.replaceFocus.current = null;
    if (owner.frame !== null) cancelAnimationFrame(owner.frame);
  };
  const retire = () => {
    if (cells.active.current !== publication) return false;
    cells.active.current = null;
    cancelReplaceFocus();
    return true;
  };
  const close = () => {
    if (!retire()) return;
    authority.onClose();
  };
  const nextOptions = (key: keyof FindOptions): FindOptions =>
    Object.freeze({ ...authority.optionValues, [key]: !authority.optionValues[key] });

  const controlOwners = new Map<FindControl, ElementOwner<HTMLButtonElement>>();
  const ownsControl = (
    control: FindControlPublication,
    owner: ElementOwner<HTMLButtonElement>,
    element: HTMLButtonElement,
    requireEnabled = true,
  ) => {
    const root = bar.element();
    return (
      ownsAuthority() &&
      owner.element() === element &&
      !!root &&
      root.isConnected &&
      element.isConnected &&
      root.contains(element) &&
      (!requireEnabled || (control.enabled && !element.disabled))
    );
  };
  const makeControl = ({
    id,
    enabled = true,
    keepInputFocus = false,
    run,
  }: {
    id: FindControl;
    enabled?: boolean;
    keepInputFocus?: boolean;
    run: () => void;
  }): FindControlPublication => {
    // Radix's asChild trigger may detach and reattach its composed ref to the same button.
    const owner = new ElementOwner<HTMLButtonElement>(retireOnReplacement, false);
    controlOwners.set(id, owner);
    const control: FindControlPublication = Object.freeze({
      id,
      enabled,
      capture: owner.capture,
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        if (!ownsControl(control, owner, event.currentTarget) || !claim(event)) return;
        run();
      },
      ...(keepInputFocus
        ? {
            onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
              if (
                !ownsControl(control, owner, event.currentTarget) ||
                cells.claimedMouseDowns.has(event)
              ) return;
              cells.claimedMouseDowns.add(event);
              event.preventDefault();
            },
          }
        : {}),
    });
    return control;
  };

  const controls: Record<FindControl, FindControlPublication> = {
    matchCase: makeControl({
      id: "matchCase",
      keepInputFocus: true,
      run: () => update(authority.query, nextOptions("matchCase")),
    }),
    wholeWord: makeControl({
      id: "wholeWord",
      keepInputFocus: true,
      run: () => update(authority.query, nextOptions("wholeWord")),
    }),
    regex: makeControl({
      id: "regex",
      keepInputFocus: true,
      run: () => update(authority.query, nextOptions("regex")),
    }),
    previous: makeControl({
      id: "previous",
      enabled: !authority.actionsDisabled,
      keepInputFocus: true,
      run: () => step(-1),
    }),
    next: makeControl({
      id: "next",
      enabled: !authority.actionsDisabled,
      keepInputFocus: true,
      run: () => step(1),
    }),
    toggleReplace: makeControl({
      id: "toggleReplace",
      enabled: authority.canEdit,
      keepInputFocus: true,
      run: () => {
        if (authority.replaceVisible) {
          cancelReplaceFocus();
          authority.onReplaceVisible(false);
          return;
        }
        const intent: ReplaceFocusIntent = { source: publication };
        cells.replaceIntent.current = intent;
        authority.onReplaceVisible(true);
      },
    }),
    close: makeControl({ id: "close", run: close }),
    replaceOne: makeControl({
      id: "replaceOne",
      enabled: authority.showReplace && !authority.actionsDisabled,
      run: replaceOne,
    }),
    replaceAll: makeControl({
      id: "replaceAll",
      enabled: authority.showReplace && !authority.actionsDisabled,
      run: replaceAll,
    }),
  };

  const closeFromKeyboard = (
    event: KeyboardEvent<HTMLDivElement> | KeyboardEvent<HTMLInputElement>,
  ) => {
    if (!claim(event)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const search: FindInputPublication = Object.freeze({
    capture: searchOwner.capture,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      if (!ownsInput("search", event.currentTarget) || !claim(event)) return;
      update(event.currentTarget.value, authority.options);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (!ownsInput("search", event.currentTarget)) return;
      if (event.key === "Escape") {
        closeFromKeyboard(event);
        return;
      }
      if (event.key !== "Enter" || !claim(event)) return;
      event.preventDefault();
      if (!authority.invalidRegex) step(event.shiftKey ? -1 : 1);
    },
  });
  const replacement: FindInputPublication = Object.freeze({
    capture: replaceOwner.capture,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      if (!ownsInput("replace", event.currentTarget) || !claim(event)) return;
      setReplacementDraft({ visit: authority.visit, value: event.currentTarget.value });
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (!ownsInput("replace", event.currentTarget)) return;
      if (event.key === "Escape") {
        closeFromKeyboard(event);
        return;
      }
      if (event.key !== "Enter" || !claim(event)) return;
      event.preventDefault();
      if (authority.invalidRegex) return;
      if (event.shiftKey) step(-1);
      else replaceOne();
    },
  });

  const expectedControls = () => [
    controls.matchCase,
    controls.wholeWord,
    controls.regex,
    controls.previous,
    controls.next,
    controls.close,
    ...(authority.canEdit ? [controls.toggleReplace] : []),
    ...(authority.showReplace ? [controls.replaceOne, controls.replaceAll] : []),
  ];
  const exactDomIsCurrent = () => {
    const root = bar.element();
    const searchElement = searchOwner.element();
    const replaceElement = replaceOwner.element();
    return (
      !!root &&
      root.isConnected &&
      !!searchElement &&
      searchElement.isConnected &&
      root.contains(searchElement) &&
      (authority.showReplace
        ? !!replaceElement && replaceElement.isConnected && root.contains(replaceElement)
        : replaceElement === null) &&
      expectedControls().every((control) => {
        const element = controlOwners.get(control.id)?.element();
        return !!element && element.isConnected && root.contains(element);
      })
    );
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    if (!factsAreCurrent() || !exactDomIsCurrent()) return;
    cells.active.current = publication;
    if (
      cells.focusRequest.current !== authority.focusRequest &&
      focusSearch()
    ) {
      cells.focusRequest.current = authority.focusRequest;
    }

    const intent = cells.replaceIntent.current;
    if (intent && intent.source !== publication) {
      cells.replaceIntent.current = null;
      if (isExactReplaceSuccessor(intent.source, publication)) {
        scheduleReplaceFocus();
      }
    }
  };
  const focusSearch = () => {
    const element = searchOwner.element();
    if (!element || !ownsInput("search", element)) return false;
    element.focus();
    if (ownsInput("search", element)) element.select();
    return true;
  };
  const scheduleReplaceFocus = () => {
    const element = replaceOwner.element();
    if (!element || !ownsInput("replace", element)) return false;
    const owner: ReplaceFocusOwner = { publication, element, frame: null };
    cells.replaceFocus.current = owner;
    const frame = requestAnimationFrame(() => {
      if (
        owner.frame !== frame ||
        cells.replaceFocus.current !== owner ||
        !ownsInput("replace", owner.element)
      ) return;
      cells.replaceFocus.current = null;
      owner.element.focus();
    });
    owner.frame = frame;
    return true;
  };
  const onBarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ownsBar(event.currentTarget)) return;
    const root = bar.element();
    const target = event.target;
    if (
      !root ||
      !(target instanceof Node) ||
      !target.isConnected ||
      (target !== root && !root.contains(target)) ||
      event.key !== "Escape"
    ) return;
    closeFromKeyboard(event);
  };

  const publication: FindBarPublication = Object.freeze({
    authority,
    captureBar: bar.capture,
    inputs: Object.freeze({ search, replace: replacement }),
    controls: Object.freeze(controls),
    establish,
    retire,
    ownsInput,
    focusSearch,
    scheduleReplaceFocus,
    onBarKeyDown,
  });
  return publication;
}

function OptionToggle({
  label,
  active,
  control,
  testId,
  children,
}: {
  label: string;
  active: boolean;
  control: FindControlPublication;
  testId: string;
  children: ReactNode;
}) {
  const { capture, onMouseDown, onClick } = control;
  return (
    <Tip label={label}>
      <button
        ref={capture}
        type="button"
        className="icon-btn h-7 w-7 rounded-md"
        data-active={active ? "true" : undefined}
        aria-pressed={active}
        aria-label={label}
        onMouseDown={onMouseDown}
        onClick={onClick}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

export function FindBar({
  session,
  replaceVisible,
  onReplaceVisible,
  focusNonce,
  onReveal,
  onClose,
}: FindBarProps) {
  const [mount] = useState(() => Symbol("find bar mount"));
  const visit = useMemo<FindBarVisit>(() => Object.freeze({ mount, session }), [mount, session]);
  const focusRequest = useMemo<SearchFocusRequest>(
    () => Object.freeze({ visit, focusNonce }),
    [focusNonce, visit],
  );
  const { find, canEdit, total, active } = useSessionValue(
    session,
    (current) => ({
      find: current.find,
      canEdit: current.canEdit,
      total: current.find?.matches.length ?? 0,
      active: current.find?.active ?? -1,
    }),
    shallowEqual,
  );
  const [replacementDraft, setReplacementDraft] = useState<ReplacementDraft>(
    () => ({ visit, value: "" }),
  );
  const [cells] = useState<PublicationCells>(() => ({
    active: new CurrentCell<FindBarPublication | null>(null),
    focusRequest: new CurrentCell<SearchFocusRequest | null>(null),
    replaceIntent: new CurrentCell<ReplaceFocusIntent | null>(null),
    replaceFocus: new CurrentCell<ReplaceFocusOwner | null>(null),
    claimedActivations: new WeakSet<object>(),
    claimedMouseDowns: new WeakSet<object>(),
  }));
  const replacement = replacementDraft.visit === visit ? replacementDraft.value : "";
  const options = find?.options;
  const query = find?.query ?? "";
  const invalidRegex = options ? compileFindRegex(query, options).invalid : false;
  const showReplace = replaceVisible && canEdit;
  const noMatches = total === 0;
  const actionsDisabled = invalidRegex || noMatches;

  const publication = find && options
    ? createFindBarPublication({
        authority: Object.freeze({
          visit,
          session,
          find,
          options,
          optionValues: Object.freeze({
            matchCase: options.matchCase,
            wholeWord: options.wholeWord,
            regex: options.regex,
          }),
          matches: find.matches,
          query,
          replacement,
          canEdit,
          total,
          active,
          replaceVisible,
          showReplace,
          focusNonce,
          focusRequest,
          invalidRegex,
          noMatches,
          actionsDisabled,
          methods: Object.freeze({
            setFind: session.setFind,
            stepFind: session.stepFind,
            replaceActive: session.replaceActive,
            replaceAll: session.replaceAll,
          }),
          onReplaceVisible,
          onReveal,
          onClose,
        }),
        cells,
        setReplacementDraft,
      })
    : null;
  const lifecycle = publication ?? createInactivePublication(cells);

  useLayoutEffect(() => {
    lifecycle.establish();
    return lifecycle.retire;
  }, [lifecycle]);

  if (!publication || !options) return null;

  const {
    captureBar,
    inputs,
    controls,
    onBarKeyDown,
  } = publication;
  const { search: searchInput, replace: replaceInput } = inputs;
  const {
    matchCase,
    wholeWord,
    regex,
    previous,
    next,
    toggleReplace,
    close,
    replaceOne,
    replaceAll,
  } = controls;
  const {
    capture: captureSearch,
    onChange: onSearchChange,
    onKeyDown: onSearchKeyDown,
  } = searchInput;
  const {
    capture: captureReplace,
    onChange: onReplaceChange,
    onKeyDown: onReplaceKeyDown,
  } = replaceInput;
  const { capture: capturePrevious, onMouseDown: onPreviousMouseDown, onClick: onPreviousClick } = previous;
  const { capture: captureNext, onMouseDown: onNextMouseDown, onClick: onNextClick } = next;
  const {
    capture: captureToggleReplace,
    onMouseDown: onToggleReplaceMouseDown,
    onClick: onToggleReplaceClick,
  } = toggleReplace;
  const { capture: captureClose, onClick: onCloseClick } = close;
  const { capture: captureReplaceOne, onClick: onReplaceOneClick } = replaceOne;
  const { capture: captureReplaceAll, onClick: onReplaceAllClick } = replaceAll;
  const counter = query ? `${total === 0 ? 0 : active + 1} of ${total}` : "";
  return (
    <div
      ref={captureBar}
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
            ref={captureSearch}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            placeholder="Find"
            value={query}
            onChange={onSearchChange}
            onKeyDown={onSearchKeyDown}
            spellCheck={false}
            autoComplete="off"
            aria-label="Find"
            aria-invalid={invalidRegex}
            aria-describedby={invalidRegex ? "find-regex-error" : undefined}
            data-testid="find-input"
          />
          <OptionToggle label="Match case" active={options.matchCase} control={matchCase} testId="find-match-case">
            <CaseSensitive size={15} />
          </OptionToggle>
          <OptionToggle label="Whole word" active={options.wholeWord} control={wholeWord} testId="find-whole-word">
            <WholeWord size={15} />
          </OptionToggle>
          <OptionToggle label="Regular expression" active={options.regex} control={regex} testId="find-regex">
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
          <button
            ref={capturePrevious}
            type="button"
            className="icon-btn h-7 w-7 rounded-md"
            disabled={actionsDisabled}
            onMouseDown={onPreviousMouseDown}
            onClick={onPreviousClick}
            aria-label="Previous match"
            data-testid="find-prev"
          >
            <ChevronUp size={16} />
          </button>
        </Tip>
        <Tip label="Next match" shortcut="Enter">
          <button
            ref={captureNext}
            type="button"
            className="icon-btn h-7 w-7 rounded-md"
            disabled={actionsDisabled}
            onMouseDown={onNextMouseDown}
            onClick={onNextClick}
            aria-label="Next match"
            data-testid="find-next"
          >
            <ChevronDown size={16} />
          </button>
        </Tip>
        {canEdit && (
          <Tip label={replaceVisible ? "Hide replace" : "Replace"} shortcut={replaceVisible ? undefined : shortcut(findReplaceShortcut())}>
            <button
              ref={captureToggleReplace}
              type="button"
              className={cn("btn btn-ghost h-8 shrink-0 gap-1.5 px-2 text-[13px]", replaceVisible && "bg-surface-3 text-ink")}
              onMouseDown={onToggleReplaceMouseDown}
              onClick={onToggleReplaceClick}
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
          <button
            ref={captureClose}
            type="button"
            className="icon-btn mt-0.5 h-7 w-7 shrink-0 rounded-md"
            onClick={onCloseClick}
            aria-label="Close find"
            data-testid="find-close"
          >
            <X size={15} />
          </button>
        </Tip>
      </div>
      {showReplace && (
        <div id="find-replace-row" className="flex flex-wrap items-center gap-1.5" data-testid="find-replace-row">
          <div className="min-w-[9rem] flex-1 md:w-[min(420px,40vw)] md:flex-none">
            <input
              ref={captureReplace}
              className="input h-8 text-[13px]"
              placeholder="Replace with"
              value={replacement}
              onChange={onReplaceChange}
              onKeyDown={onReplaceKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label="Replace with"
              data-testid="replace-input"
            />
          </div>
          <button
            ref={captureReplaceOne}
            type="button"
            className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]"
            disabled={actionsDisabled}
            onClick={onReplaceOneClick}
            data-testid="replace-one"
          >
            Replace
          </button>
          <button
            ref={captureReplaceAll}
            type="button"
            className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]"
            disabled={actionsDisabled}
            onClick={onReplaceAllClick}
            data-testid="replace-all"
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
