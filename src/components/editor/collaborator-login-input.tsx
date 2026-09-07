"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { api, apiErrorText, type GitHubUserDto } from "@/lib/api";
import { Avatar } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** Keystrokes settle for this long before one request goes out for the typed prefix. */
export const SUGGEST_DEBOUNCE_MS = 250;
/** Shorter prefixes are not searched (the route refuses them as well). */
export const SUGGEST_MIN_CHARS = 2;
/** The route answers at most this many; the list never shows more. */
export const SUGGEST_MAX = 8;

/** The login prefix worth searching for what was typed — trimmed, without a leading `@` — or null when too short or not a login. */
export function suggestQuery(value: string): string | null {
  const q = value.trim().replace(/^@/, "");
  return q.length >= SUGGEST_MIN_CHARS && q.length <= 39 && /^[a-zA-Z0-9-]+$/.test(q) ? q : null;
}

type InputScope = {
  value: string;
  onChange: (value: string) => void;
  onPick?: (login: string) => void;
  excluded: ReadonlySet<string>;
  query: string | null;
};

type LookupState =
  | { query: QueryAuthority; status: "loading" }
  | {
      query: QueryAuthority;
      status: "error";
      message: string;
      retrying: boolean;
    };

type TimerAuthority = {
  query: QueryAuthority;
  handle: ReturnType<typeof setTimeout> | null;
  pending: boolean;
};

type RequestAuthority = {
  query: QueryAuthority;
  controller: AbortController;
};

type QueryAuthority = {
  scope: InputScope;
  query: string;
  timer: TimerAuthority | null;
  request: RequestAuthority | null;
  started: boolean;
  retired: boolean;
};

type PublishedState = {
  scope: InputScope;
  query: QueryAuthority | null;
  options: GitHubUserDto[];
  open: boolean;
  active: number;
  lookup: LookupState | null;
};

type VisiblePublication = {
  state: PublishedState | null;
  visible: GitHubUserDto[];
  expanded: boolean;
  activeIndex: number;
  lookup: LookupState | null;
};

type ControlBinding = {
  scope: InputScope;
};

type RetryPublication = {
  error: Extract<LookupState, { status: "error" }>;
};

type SuggestionRowPublication = {
  candidate: GitHubUserDto;
  index: number;
  optionId: string;
  login: string;
  name: string | null;
  avatarUrl: string;
};

type SuggestionListPublication = {
  rows: SuggestionRowPublication[];
};

type InputVisit = {
  scope: InputScope;
  binding: ControlBinding;
  control: HTMLDivElement | null;
  input: HTMLInputElement | null;
  query: QueryAuthority | null;
  publication: VisiblePublication;
  retry: RetryPublication | null;
  list: SuggestionListPublication | null;
};

/**
 * The Share dialog's handle box with GitHub-account suggestions: an ARIA combobox over a listbox of
 * up to eight `@login`s that appears once two login characters have settled for 250 ms. ↓/↑ move,
 * Enter picks the active option (with none active it submits the typed handle as before), Escape
 * closes the list (the dialog stays open), a click picks. Picking fills the box and calls `onPick` so
 * the owner lands on the role select and still presses Add. Temporary lookup failures leave exact
 * handles usable and offer one guarded retry instead of looking like a truthful empty result.
 * A session without a GitHub token (`reason: "no-github-token"`) is remembered for the life of the
 * box: it asks no more and stays a plain text field.
 */
export function CollaboratorLoginInput({
  value,
  onChange,
  exclude,
  onPick,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Logins already listed (owner and collaborators): never suggested again. */
  exclude: string[];
  /** After a suggestion filled the box; the dialog moves focus on to the role select. */
  onPick?: (login: string) => void;
}) {
  const listId = useId();
  const feedbackId = `${listId}-feedback`;
  const query = suggestQuery(value);
  const exclusionKey = [...new Set(exclude.map((login) => login.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))].sort().join("\0");
  const excluded = useMemo<ReadonlySet<string>>(() => new Set(exclusionKey ? exclusionKey.split("\0") : []), [exclusionKey]);
  const scope = useMemo<InputScope>(() => ({ value, onChange, onPick, excluded, query }), [value, onChange, onPick, excluded, query]);

  const [controlElement, setControlElement] = useState<HTMLDivElement | null>(null);
  const [inputElement, setInputElement] = useState<HTMLInputElement | null>(null);
  const currentBinding = useRef<ControlBinding | null>(null);
  const currentVisit = useRef<InputVisit | null>(null);
  const currentQuery = useRef<QueryAuthority | null>(null);
  const controlNodes = useRef(new WeakMap<ControlBinding, HTMLDivElement>());
  const inputNodes = useRef(new WeakMap<ControlBinding, HTMLInputElement>());
  const publicationNodes = useRef(new WeakMap<RetryPublication | SuggestionListPublication | SuggestionRowPublication, HTMLElement>());
  const claimedPublications = useRef(new WeakSet<object>());
  const cache = useRef(new Map<string, GitHubUserDto[]>());
  // The login a pick just wrote into the box: it is not searched again (its owner is about to press Add).
  const picked = useRef<string | null>(null);
  // Set once the route answered `reason: "no-github-token"`: this mounted box cannot search again.
  const noToken = useRef(false);
  const [published, setPublished] = useState<PublishedState | null>(null);

  const state = published?.scope === scope ? published : null;
  const visible = useMemo(() => (state ? state.options.filter((candidate) => !scope.excluded.has(candidate.login.toLowerCase())).slice(0, SUGGEST_MAX) : []), [scope, state]);
  const expanded = !!state?.open && visible.length > 0;
  const activeIndex = state && state.active >= 0 && state.active < visible.length ? state.active : -1;
  const currentLookup = state && state.lookup?.query === state.query ? state.lookup : null;
  const publication = useMemo<VisiblePublication>(() => ({ state, visible, expanded, activeIndex, lookup: currentLookup }), [activeIndex, currentLookup, expanded, state, visible]);

  const cancelTimer = useCallback((owner: QueryAuthority, timer: TimerAuthority) => {
    if (owner.timer !== timer || !timer.pending) return;
    owner.timer = null;
    timer.pending = false;
    if (timer.handle !== null) clearTimeout(timer.handle);
  }, []);

  const retireQuery = useCallback(
    (owner: QueryAuthority) => {
      if (owner.retired) return;
      owner.retired = true;
      const timer = owner.timer;
      if (timer) cancelTimer(owner, timer);
      const request = owner.request;
      owner.request = null;
      if (request && !request.controller.signal.aborted) request.controller.abort();
      if (currentQuery.current === owner) currentQuery.current = null;
    },
    [cancelTimer],
  );

  const retireVisitPublication = useCallback((owner: InputVisit) => {
    if (currentVisit.current === owner) currentVisit.current = null;
  }, []);

  const retireControlBinding = useCallback(
    (owner: ControlBinding) => {
      if (currentBinding.current !== owner) return;
      const visitOwner = currentVisit.current;
      if (visitOwner?.binding === owner) currentVisit.current = null;
      currentBinding.current = null;
      const queryOwner = currentQuery.current;
      if (queryOwner?.scope === owner.scope) retireQuery(queryOwner);
    },
    [retireQuery],
  );

  const binding = useMemo<ControlBinding>(() => ({ scope }), [scope]);

  const setControlNode = useCallback(
    (node: HTMLDivElement | null) => {
      const previous = controlNodes.current.get(binding) ?? null;
      if (previous === node) return;
      if (node) controlNodes.current.set(binding, node);
      else controlNodes.current.delete(binding);
      if (previous) retireControlBinding(binding);
      if (node && (currentBinding.current === null || currentBinding.current === binding)) setControlElement(node);
    },
    [binding, retireControlBinding],
  );

  const setInputNode = useCallback(
    (node: HTMLInputElement | null) => {
      const previous = inputNodes.current.get(binding) ?? null;
      if (previous === node) return;
      if (node) inputNodes.current.set(binding, node);
      else inputNodes.current.delete(binding);
      if (previous) retireControlBinding(binding);
      if (node && (currentBinding.current === null || currentBinding.current === binding)) setInputElement(node);
    },
    [binding, retireControlBinding],
  );

  const isVisitDomCurrent = useCallback(
    (owner: InputVisit) => {
      const control = owner.control;
      const input = owner.input;
      if (controlNodes.current.get(owner.binding) !== control || inputNodes.current.get(owner.binding) !== input || !control || !input || !control.isConnected || !input.isConnected || input.parentElement !== control) {
        return false;
      }

      const error = owner.publication.lookup?.status === "error" ? owner.publication.lookup : null;
      if (error) {
        const retryPublication = owner.retry;
        const retryNode = retryPublication ? publicationNodes.current.get(retryPublication) : null;
        if (!retryPublication || retryPublication.error !== error || !retryNode || !retryNode.isConnected || !control.contains(retryNode)) {
          return false;
        }
      } else if (owner.retry) {
        return false;
      }

      if (!owner.publication.expanded) return owner.list === null;
      const listPublication = owner.list;
      const listNode = listPublication ? publicationNodes.current.get(listPublication) : null;
      if (!listPublication || !listNode || !listNode.isConnected || listNode.parentElement !== control || listPublication.rows.length !== owner.publication.visible.length) {
        return false;
      }
      return listPublication.rows.every((row, index) => {
        const candidate = owner.publication.visible[index];
        const rowNode = publicationNodes.current.get(row);
        return (
          row.index === index &&
          row.candidate === candidate &&
          row.login === candidate?.login &&
          row.name === candidate?.name &&
          row.avatarUrl === candidate?.avatarUrl &&
          row.optionId === `${listId}-option-${index}` &&
          rowNode instanceof HTMLLIElement &&
          rowNode.isConnected &&
          rowNode.parentElement === listNode &&
          listNode.children.item(index) === rowNode &&
          rowNode.id === row.optionId &&
          rowNode.dataset.login === row.login
        );
      });
    },
    [listId],
  );

  const ownsVisitIdentity = useCallback((owner: InputVisit) => currentVisit.current === owner && currentBinding.current === owner.binding && owner.binding.scope === owner.scope && isVisitDomCurrent(owner), [isVisitDomCurrent]);

  const ownsVisit = useCallback((owner: InputVisit) => ownsVisitIdentity(owner) && owner.query === currentQuery.current, [ownsVisitIdentity]);

  const ownsQuery = useCallback((owner: QueryAuthority) => !owner.retired && currentQuery.current === owner && currentVisit.current?.scope === owner.scope && ownsVisitIdentity(currentVisit.current), [ownsVisitIdentity]);

  const ownsRequest = useCallback((owner: QueryAuthority, request: RequestAuthority) => ownsQuery(owner) && owner.request === request && request.query === owner, [ownsQuery]);

  const makeQuery = useCallback((ownerScope: InputScope, started = false): QueryAuthority | null => {
    if (!ownerScope.query || ownerScope.query === picked.current || noToken.current) return null;
    return {
      scope: ownerScope,
      query: ownerScope.query,
      timer: null,
      request: null,
      started,
      retired: false,
    };
  }, []);

  const visit = useMemo<InputVisit>(() => {
    const retryPublication: RetryPublication | null =
      publication.lookup?.status === "error"
        ? {
            error: publication.lookup,
          }
        : null;
    const listPublication: SuggestionListPublication | null = publication.expanded
      ? {
          rows: publication.visible.map((candidate, index) => ({
            candidate,
            index,
            optionId: `${listId}-option-${index}`,
            login: candidate.login,
            name: candidate.name,
            avatarUrl: candidate.avatarUrl,
          })),
        }
      : null;
    return {
      scope,
      binding,
      control: controlElement,
      input: inputElement,
      query: state?.query ?? null,
      publication,
      retry: retryPublication,
      list: listPublication,
    };
  }, [binding, controlElement, inputElement, listId, publication, scope, state?.query]);

  const setRetryNode = useCallback(
    (owner: InputVisit, node: HTMLButtonElement | null) => {
      const retryPublication = owner.retry;
      if (!retryPublication) return;
      const previous = publicationNodes.current.get(retryPublication) ?? null;
      if (previous === node) return;
      if (node) publicationNodes.current.set(retryPublication, node);
      else publicationNodes.current.delete(retryPublication);
      if (previous) retireVisitPublication(owner);
    },
    [retireVisitPublication],
  );

  const setListNode = useCallback(
    (owner: InputVisit, node: HTMLUListElement | null) => {
      const listPublication = owner.list;
      if (!listPublication) return;
      const previous = publicationNodes.current.get(listPublication) ?? null;
      if (previous === node) return;
      if (node) publicationNodes.current.set(listPublication, node);
      else publicationNodes.current.delete(listPublication);
      if (previous) retireVisitPublication(owner);
    },
    [retireVisitPublication],
  );

  const setRowNode = useCallback(
    (owner: InputVisit, index: number, node: HTMLLIElement | null) => {
      const row = owner.list?.rows[index];
      if (!row) return;
      const previous = publicationNodes.current.get(row) ?? null;
      if (previous === node) return;
      if (node) publicationNodes.current.set(row, node);
      else publicationNodes.current.delete(row);
      if (previous) retireVisitPublication(owner);
    },
    [retireVisitPublication],
  );

  useLayoutEffect(() => {
    const previous = currentVisit.current;
    if (previous) retireVisitPublication(previous);
    const control = visit.control;
    const input = visit.input;
    if (!control || !input || controlNodes.current.get(binding) !== control || inputNodes.current.get(binding) !== input || !control.isConnected || !input.isConnected || input.parentElement !== control) {
      if (currentBinding.current === binding) retireControlBinding(binding);
      return;
    }

    const replaced = currentBinding.current !== binding;
    if (replaced) {
      const previousBinding = currentBinding.current;
      if (previousBinding) retireControlBinding(previousBinding);
      const previousQuery = currentQuery.current;
      if (previousQuery) retireQuery(previousQuery);
      currentBinding.current = binding;
      const owner = makeQuery(scope);
      currentQuery.current = owner;
      setPublished({
        scope,
        query: owner,
        options: [],
        open: false,
        active: -1,
        lookup: owner ? { query: owner, status: "loading" } : null,
      });
    }

    const owner = currentQuery.current?.scope === scope ? currentQuery.current : null;
    currentVisit.current = visit.binding === binding && visit.control === control && visit.input === input && visit.query === owner && isVisitDomCurrent(visit) ? visit : null;
    return () => retireVisitPublication(visit);
  }, [binding, isVisitDomCurrent, makeQuery, retireControlBinding, retireQuery, retireVisitPublication, scope, visit]);

  const publishForQuery = useCallback(
    (owner: QueryAuthority, update: (previous: PublishedState) => PublishedState) => {
      if (!ownsQuery(owner)) return;
      setPublished((previous) => {
        if (previous?.scope !== owner.scope || previous.query !== owner) return previous;
        return update(previous);
      });
    },
    [ownsQuery],
  );

  const show = useCallback(
    (owner: QueryAuthority, users: GitHubUserDto[]) => {
      if (!ownsQuery(owner)) return;
      const input = currentVisit.current?.input;
      publishForQuery(owner, (previous) => ({
        ...previous,
        options: users,
        active: -1,
        open: users.some((candidate) => !owner.scope.excluded.has(candidate.login.toLowerCase())) && document.activeElement === input,
      }));
    },
    [ownsQuery, publishForQuery],
  );

  const runLookup = useCallback(
    (owner: QueryAuthority) => {
      if (noToken.current || !ownsQuery(owner) || owner.request) return;
      const controller = new AbortController();
      const request: RequestAuthority = { query: owner, controller };
      owner.request = request;
      void api.github
        .searchUsers(owner.query, { signal: controller.signal })
        .then((result) => {
          if (!ownsRequest(owner, request)) return;
          owner.request = null;
          if (result.reason === "no-github-token") {
            noToken.current = true;
            setPublished((previous) =>
              previous?.scope === owner.scope && previous.query === owner
                ? {
                    scope: owner.scope,
                    query: null,
                    options: [],
                    open: false,
                    active: -1,
                    lookup: null,
                  }
                : previous,
            );
            retireQuery(owner);
            return;
          }
          if (result.limited) {
            show(owner, []);
            publishForQuery(owner, (previous) => ({
              ...previous,
              lookup: {
                query: owner,
                status: "error",
                message: `GitHub suggestions for @${owner.query} are temporarily unavailable.`,
                retrying: false,
              },
            }));
            return;
          }
          if (!ownsQuery(owner)) return;
          cache.current.set(owner.query.toLowerCase(), result.users);
          show(owner, result.users);
          publishForQuery(owner, (previous) => ({ ...previous, lookup: null }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || !ownsRequest(owner, request)) return;
          owner.request = null;
          const reason = apiErrorText(error, "");
          show(owner, []);
          publishForQuery(owner, (previous) => ({
            ...previous,
            lookup: {
              query: owner,
              status: "error",
              message: reason ? `GitHub suggestions for @${owner.query}: ${reason}` : `GitHub suggestions for @${owner.query} are temporarily unavailable.`,
              retrying: false,
            },
          }));
        })
        .finally(() => {
          if (ownsRequest(owner, request)) owner.request = null;
        });
    },
    [ownsQuery, ownsRequest, publishForQuery, retireQuery, show],
  );

  useEffect(() => {
    const owner = currentQuery.current;
    if (!owner || owner.scope !== scope || owner.started || !ownsQuery(owner)) return;
    owner.started = true;
    const cached = cache.current.get(owner.query.toLowerCase());
    if (cached) {
      show(owner, cached);
      publishForQuery(owner, (previous) => ({ ...previous, lookup: null }));
      return;
    }

    const timer: TimerAuthority = { query: owner, handle: null, pending: true };
    owner.timer = timer;
    timer.handle = setTimeout(() => {
      if (!timer.pending || timer.query !== owner || owner.timer !== timer || !ownsQuery(owner)) return;
      timer.pending = false;
      owner.timer = null;
      runLookup(owner);
    }, SUGGEST_DEBOUNCE_MS);
    return () => cancelTimer(owner, timer);
  }, [cancelTimer, ownsQuery, publishForQuery, runLookup, scope, show, state?.query]);

  const updateVisitState = useCallback(
    (owner: InputVisit, update: (previous: PublishedState) => PublishedState) => {
      if (!ownsVisit(owner) || !owner.publication.state) return;
      const ownedState = owner.publication.state;
      setPublished((previous) => {
        if (!ownsVisit(owner) || previous !== ownedState) return previous;
        return update(ownedState);
      });
    },
    [ownsVisit],
  );

  const cancelVisitLookup = useCallback(
    (owner: InputVisit) => {
      if (!ownsVisit(owner) || !owner.publication.state) return;
      const ownedState = owner.publication.state;
      const queryOwner = currentQuery.current;
      if (queryOwner?.scope === owner.scope) retireQuery(queryOwner);
      setPublished((previous) =>
        ownsVisitIdentity(owner) && previous === ownedState
          ? {
              ...ownedState,
              query: null,
              open: false,
              active: -1,
              lookup: null,
            }
          : previous,
      );
    },
    [ownsVisit, ownsVisitIdentity, retireQuery],
  );

  const ownsOption = useCallback(
    (owner: InputVisit, row: SuggestionRowPublication) =>
      ownsVisit(owner) &&
      owner.publication.expanded &&
      owner.list?.rows[row.index] === row &&
      owner.publication.visible[row.index] === row.candidate &&
      row.login === row.candidate.login &&
      row.name === row.candidate.name &&
      row.avatarUrl === row.candidate.avatarUrl &&
      !owner.scope.excluded.has(row.login.toLowerCase()) &&
      !claimedPublications.current.has(owner) &&
      !claimedPublications.current.has(row),
    [ownsVisit],
  );

  const pick = useCallback(
    (owner: InputVisit, row: SuggestionRowPublication) => {
      if (!ownsOption(owner, row) || !owner.publication.state) return;
      claimedPublications.current.add(owner);
      claimedPublications.current.add(row);
      const ownedState = owner.publication.state;
      picked.current = row.login;
      setPublished((previous) =>
        ownsVisitIdentity(owner) && previous === ownedState
          ? {
              ...ownedState,
              query: null,
              open: false,
              active: -1,
              lookup: null,
            }
          : previous,
      );
      owner.scope.onChange(row.login);
      if (!ownsVisitIdentity(owner)) return;
      owner.scope.onPick?.(row.login);
      if (!ownsVisitIdentity(owner)) return;
      const queryOwner = currentQuery.current;
      if (queryOwner?.scope === owner.scope) retireQuery(queryOwner);
    },
    [ownsOption, ownsVisitIdentity, retireQuery],
  );

  const retry = useCallback(
    (owner: InputVisit, retryPublication: RetryPublication, event: MouseEvent<HTMLButtonElement>) => {
      const button = event.currentTarget;
      const error = retryPublication.error;
      if (
        !ownsVisit(owner) ||
        owner.retry !== retryPublication ||
        publicationNodes.current.get(retryPublication) !== button ||
        !button.isConnected ||
        !owner.control?.contains(button) ||
        button.disabled ||
        claimedPublications.current.has(retryPublication) ||
        owner.publication.lookup !== error ||
        error.query !== currentQuery.current ||
        error.query.scope !== owner.scope ||
        error.query.query !== owner.scope.query ||
        error.retrying ||
        noToken.current ||
        error.query.request
      ) {
        return;
      }

      claimedPublications.current.add(retryPublication);
      owner.input?.focus();
      if (!ownsVisit(owner)) return;
      retireQuery(error.query);
      const next = makeQuery(owner.scope, true);
      if (!next) return;
      currentQuery.current = next;
      setPublished((previous) =>
        previous === owner.publication.state
          ? {
              scope: owner.scope,
              query: next,
              options: [],
              open: false,
              active: -1,
              lookup: {
                query: next,
                status: "error",
                message: error.message,
                retrying: true,
              },
            }
          : previous,
      );
      runLookup(next);
    },
    [makeQuery, ownsVisit, retireQuery, runLookup],
  );

  const leaveControl = (owner: InputVisit, event: FocusEvent<HTMLDivElement>) => {
    const source = event.currentTarget;
    const control = owner.control;
    if (!control || source !== control || !source.isConnected || !ownsVisit(owner)) return;
    if (event.relatedTarget instanceof Node && control.contains(event.relatedTarget)) return;
    cancelVisitLookup(owner);
  };

  const changeInput = (owner: InputVisit, event: ChangeEvent<HTMLInputElement>) => {
    const source = event.currentTarget;
    if (source !== owner.input || !source.isConnected || !owner.control?.contains(source) || !ownsVisit(owner)) return;
    if (event.target !== source) return;
    picked.current = null;
    owner.scope.onChange(source.value);
  };

  const focusInput = (owner: InputVisit, event: FocusEvent<HTMLInputElement>) => {
    const source = event.currentTarget;
    if (source !== owner.input || !source.isConnected || !owner.control?.contains(source) || !ownsVisit(owner) || owner.publication.visible.length === 0) {
      return;
    }
    updateVisitState(owner, (previous) => ({ ...previous, open: true }));
  };

  const onKeyDown = (owner: InputVisit, event: KeyboardEvent<HTMLInputElement>) => {
    const source = event.currentTarget;
    if (source !== owner.input || !source.isConnected || !owner.control?.contains(source) || !ownsVisit(owner)) return;
    const ownerPublication = owner.publication;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const count = ownerPublication.visible.length;
      if (count === 0) return;
      event.preventDefault();
      updateVisitState(owner, (previous) => ({
        ...previous,
        open: true,
        active: event.key === "ArrowDown" ? (ownerPublication.activeIndex + 1) % count : ownerPublication.activeIndex <= 0 ? count - 1 : ownerPublication.activeIndex - 1,
      }));
      return;
    }
    if (event.key === "Enter" && ownerPublication.expanded && ownerPublication.activeIndex >= 0) {
      const row = owner.list?.rows[ownerPublication.activeIndex];
      if (!row || !ownsOption(owner, row)) return;
      event.preventDefault();
      pick(owner, row);
      return;
    }
    if (event.key === "Escape" && ownerPublication.expanded) {
      // DialogContent leaves this Escape to the expanded combobox (see primitives.tsx), so only the list closes.
      event.preventDefault();
      updateVisitState(owner, (previous) => ({
        ...previous,
        open: false,
        active: -1,
      }));
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;
  const ownsRowEvent = (owner: InputVisit, row: SuggestionRowPublication, source: HTMLLIElement) => {
    const listNode = owner.list ? publicationNodes.current.get(owner.list) : null;
    return publicationNodes.current.get(row) === source && source.isConnected && listNode?.contains(source) === true && ownsOption(owner, row);
  };

  return (
    <div ref={setControlNode} className="relative flex-1" onBlur={(event) => leaveControl(visit, event)}>
      <UserPlus size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
      <input
        ref={setInputNode}
        className="input pl-9"
        placeholder="GitHub handle, e.g. octocat"
        aria-label="GitHub handle"
        value={value}
        onChange={(event) => changeInput(visit, event)}
        onKeyDown={(event) => onKeyDown(visit, event)}
        onFocus={(event) => focusInput(visit, event)}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-describedby={currentLookup ? feedbackId : undefined}
        autoComplete="off"
        spellCheck={false}
        data-testid="share-login"
      />
      {currentLookup?.status === "loading" && (
        <div id={feedbackId} className="mt-1 flex items-center gap-1.5 text-xs text-ink-3" role="status" aria-live="polite" aria-atomic="true" data-testid="share-login-loading">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          Loading GitHub suggestions for @{currentLookup.query.query}…
        </div>
      )}
      {currentLookup?.status === "error" && (
        <div id={feedbackId} className="mt-1 flex items-center gap-2 text-xs text-danger" role="alert" aria-atomic="true" data-testid="share-login-error">
          <span className="min-w-0 flex-1">{currentLookup.message}</span>
          <button
            ref={(node) => setRetryNode(visit, node)}
            type="button"
            className="btn btn-outline btn-sm h-6 shrink-0 px-2"
            onClick={(event) => {
              if (visit.retry) retry(visit, visit.retry, event);
            }}
            disabled={currentLookup.retrying}
            aria-busy={currentLookup.retrying || undefined}
          >
            {currentLookup.retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {expanded && (
        <ul ref={(node) => setListNode(visit, node)} id={listId} role="listbox" aria-label="Matching GitHub accounts" className="menu absolute left-0 right-0 top-full mt-1 max-h-80 overflow-y-auto" data-testid="share-login-suggestions">
          {visible.map((candidate, index) => (
            <li
              ref={(node) => setRowNode(visit, index, node)}
              key={candidate.login}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={cn("menu-item py-1.5", index === activeIndex && "bg-surface-3")}
              // Keep focus (and the list) in place while the pointer is down; the click then picks.
              onMouseDown={(event: MouseEvent<HTMLLIElement>) => {
                const row = visit.list?.rows[index];
                if (!row || row.candidate !== candidate || !ownsRowEvent(visit, row, event.currentTarget)) return;
                event.preventDefault();
              }}
              onMouseEnter={(event: MouseEvent<HTMLLIElement>) => {
                const row = visit.list?.rows[index];
                if (!row || row.candidate !== candidate || !ownsRowEvent(visit, row, event.currentTarget)) return;
                updateVisitState(visit, (previous) => ({
                  ...previous,
                  active: index,
                }));
              }}
              onClick={(event: MouseEvent<HTMLLIElement>) => {
                const row = visit.list?.rows[index];
                if (!row || row.candidate !== candidate || !ownsRowEvent(visit, row, event.currentTarget)) return;
                pick(visit, row);
              }}
              data-testid="share-login-option"
              data-login={candidate.login}
            >
              <span aria-hidden>
                <Avatar name={candidate.login} src={candidate.avatarUrl} size={20} />
              </span>
              {candidate.name && <span className="min-w-0 truncate text-[13px] text-ink">{candidate.name}</span>}
              <span className={cn("min-w-0 truncate", candidate.name ? "text-xs text-ink-3" : "text-[13px] text-ink")}>@{candidate.login}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
