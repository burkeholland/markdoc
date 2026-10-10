"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { Loader2, UserPlus } from "lucide-react";
import { api, apiErrorText, type GitHubUserDto } from "@/lib/api";
import { cn, initials } from "@/lib/utils";
import { GITHUB_LOGIN_MAX_LENGTH, GITHUB_LOGIN_PREFIX_RE, isGithubLogin } from "@/lib/github-login";

/** Keystrokes settle for this long before one request goes out for the typed prefix. */
export const SUGGEST_DEBOUNCE_MS = 250;
/** Shorter prefixes are not searched (the route refuses them as well). */
export const SUGGEST_MIN_CHARS = 2;
/** The route answers at most this many; the list never shows more. */
export const SUGGEST_MAX = 8;
/** How long the just-closed list's footprint stays a non-interactive click-shield after a pick (see `shielding` below). */
export const SHIELD_MS = 600;

function SuggestionAvatar({ login, src }: { login: string; src: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="avatar" style={{ width: 20, height: 20, fontSize: 10 }} title={login}>
      <span hidden={!failed}>{failed ? initials(login) : null}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={login}
        width={20}
        height={20}
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        hidden={failed}
      />
    </span>
  );
}

/** The login prefix worth searching for what was typed — trimmed, without a leading `@` — or null when too short or not a login. */
export function suggestQuery(value: string): string | null {
  const q = value.trim().replace(/^@/, "");
  return q.length >= SUGGEST_MIN_CHARS && q.length <= GITHUB_LOGIN_MAX_LENGTH && GITHUB_LOGIN_PREFIX_RE.test(q) ? q : null;
}

/**
 * Whether a typed handle is a syntactically valid GitHub login (trimmed, `@` optional) — used to gate the
 * Add button. Matches exactly what POST /api/documents/[id]/collaborators accepts (1-39 chars, letters,
 * digits and hyphens, then `_` and a short code for a managed account, `@` optional) so Add is never
 * stricter than the server — a login this short or shaped can still be a real GitHub user even though it
 * is too short to search suggestions for (see SUGGEST_MIN_CHARS).
 */
export function isValidLogin(value: string): boolean {
  return isGithubLogin(value.trim().replace(/^@/, ""));
}

type Lookup = Readonly<{ status: "loading" } | { status: "error"; message: string; retrying: boolean }>;

type PendingRequest = Readonly<{ id: number; controller: AbortController }>;

/** What the dialog may do to the handle field from outside: put keyboard focus in it. */
export type CollaboratorLoginInputHandle = { focus: () => void };

export function CollaboratorLoginInput({
  value,
  onChange,
  exclude,
  onPick,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Logins already listed (the owner and every collaborator): never suggested again. */
  exclude: string[];
  /** Called after a suggestion fills the box, so the dialog can move focus on (e.g. to the role select). */
  onPick?: (login: string) => void;
  ref?: Ref<CollaboratorLoginInputHandle>;
}) {
  const listId = useId();
  const feedbackId = `${listId}-feedback`;
  const query = suggestQuery(value);

  // Paired with the query it answers, not just the options themselves: a render computes `candidates`
  // from this only when `result.query` still matches the *current* (value-derived) `query` below, so a
  // keydown that lands before the effect for a newer query has run never reads an answer for an older one
  // (`handleKeyDown`'s Enter branch, in particular, never picks a suggestion fetched for text the user has
  // since changed - see `candidates` below).
  const [result, setResult] = useState<{ query: string; options: readonly GitHubUserDto[] } | null>(null);
  const [open, setOpen] = useState(false);
  // Paired with the query it was set for, not just a raw index: `activeIndex` below only honors it when its
  // `query` still matches the *current* (value-derived) `query`. Without that pairing, shrinking back to an
  // already-cached query (type "octop", ArrowDown onto its first option, then Backspace back to "octo") would
  // still read as a valid index into the *new* list: `candidates` already renders "octo"'s cached answer on
  // this very render (see the cache-hit fallback below), but the effect that would otherwise reset this to -1
  // for a new query has not run yet — an Enter landing in that gap would pick an option of "octo"'s list the
  // user never actually highlighted there, instead of submitting the typed text (same race `result`/`candidates`
  // above are paired against `query` to avoid, just one render later in the sequence).
  const [active, setActiveState] = useState<{ query: string | null; index: number }>({ query: null, index: -1 });
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [noToken, setNoToken] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  // After a pointer pick (click or tap), the just-closed list's footprint stays covered by a non-interactive
  // shield for a beat: a list sitting right above the role select and the collaborator rows below it means a
  // fast second click/tap that picked an option on its first half would otherwise land on whatever is now
  // exposed underneath. The shield only ever absorbs a click; it never fills the box or re-picks. A keyboard
  // pick (Enter) has no second click to absorb, so it never shows one.
  const [shielding, setShielding] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  // State, not a ref: `candidates` below reads it during render (for the cache-hit render-time fallback,
  // see there) and ESLint's react-hooks/refs rule rightly refuses a ref read in render — a ref's mutations
  // are invisible to React and reading one in render can show stale data. A plain object keyed by lowercase
  // login is enough (no Map identity to preserve) and is replaced immutably on every successful fetch.
  const [cache, setCache] = useState<Readonly<Record<string, readonly GitHubUserDto[]>>>({});
  const pendingRef = useRef<PendingRequest | null>(null);
  const nextRequestId = useRef(0);
  const [shieldedCandidates, setShieldedCandidates] = useState<readonly GitHubUserDto[]>([]);
  const shieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks real focus (set by the input's own focus/blur handlers) rather than reading
  // `document.activeElement`, which test harnesses can simulate without ever moving focus.
  const focusedRef = useRef(false);
  // Last real pointer position seen anywhere over the list (see the options' onMouseMove below): an option
  // that renders — or re-renders — under an already-resting pointer gets Chromium's synthetic `mouseover`
  // the instant it appears, with no `mousemove`/`pointermove` alongside it. The list is rebuilt on every
  // keystroke, so a pointer the user never moved would otherwise "hover" (and so activate, and so capture
  // Enter) whatever new option happens to land under it. Comparing against the last *moved-to* coordinates
  // is what tells a genuine hover (the pointer arriving somewhere new) apart from a resting one.
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);

  // Fetches one query, racing nothing but itself: a stale answer (superseded or aborted) is simply dropped.
  // `manualRetry` is set only by the Retry button below: a successful manual retry moves focus back to the
  // handle field so the list reopens with the fresh answer, instead of leaving focus sitting on Retry
  // (which a debounced, typing-driven lookup must never do — the user is still typing, not retrying).
  const startLookup = useCallback((q: string, options?: { manualRetry?: boolean }) => {
    const manualRetry = options?.manualRetry ?? false;
    pendingRef.current?.controller.abort();
    const controller = new AbortController();
    const id = ++nextRequestId.current;
    pendingRef.current = { id, controller };
    // The caller already shows the right in-between state: a fresh debounced lookup is already "loading"
    // (set below, before the debounce timer schedules this call) and a manual retry is already "retrying".
    void api.github
      .searchUsers(q, { signal: controller.signal })
      .then((result) => {
        if (pendingRef.current?.id !== id) return;
        pendingRef.current = null;
        if (result.reason === "no-github-token") {
          setNoToken(true);
          setLookup(null);
          return;
        }
        if (result.limited) {
          setResult({ query: q, options: [] });
          setOpen(false);
          setLookup({ status: "error", message: `GitHub suggestions for @${q} are temporarily unavailable.`, retrying: false });
          return;
        }
        const users = Object.freeze(result.users.slice());
        setCache((prev) => ({ ...prev, [q.toLowerCase()]: users }));
        setResult({ query: q, options: users });
        setLookup(null);
        if (manualRetry) {
          // Only steal focus (and reopen the list) if the user is still sitting on Retry when the
          // response lands. If they moved on while it was in flight — tabbed to the role select or Add,
          // or clicked elsewhere — pulling focus back here would yank them out from under whatever
          // they're doing now, and reopening the list over it would be worse.
          if (retryButtonRef.current && document.activeElement === retryButtonRef.current) {
            // Focusing here runs the input's own onFocus synchronously, which is what actually opens the
            // list (see handleFocus) — focusedRef may still read stale (false) if focus was on Retry.
            inputRef.current?.focus();
            setOpen(true);
          }
        } else {
          setOpen(focusedRef.current);
        }
      })
      .catch((error: unknown) => {
        if (pendingRef.current?.id !== id) return;
        pendingRef.current = null;
        if (controller.signal.aborted) return;
        const reason = apiErrorText(error, "");
        setResult({ query: q, options: [] });
        setOpen(false);
        setLookup({
          status: "error",
          message: reason ? `GitHub suggestions for @${q}: ${reason}` : `GitHub suggestions for @${q} are temporarily unavailable.`,
          retrying: false,
        });
      });
  }, []);

  // One query owns the box at a time. Whenever the typed (derived) query changes, retire whatever was in
  // flight for the old one before doing anything else, so a late answer can never land on top of a newer query.
  useEffect(() => {
    pendingRef.current?.controller.abort();
    pendingRef.current = null;
    // setActiveState directly, not the `setActive(index)` wrapper below (which closes over `query` and would
    // need to be in this effect's own deps, re-running it on every render instead of only on these five): the
    // dispatch function itself is what react-hooks/exhaustive-deps already treats as exempt from the list.
    //
    // An entry that is already for this query is kept: this effect also re-runs when only `cache` changed (the
    // answer for the current text just arrived and the list appeared), a few ms after that list was first shown.
    // Resetting then took away the highlight an ArrowDown had set in between (#2252 item 3).
    setActiveState((prev) => (prev.query === query ? prev : { query, index: -1 }));

    if (!query || noToken || query === picked) {
      // Deliberately `null`, not left as whatever answered the previous query: the just-picked login can equal
      // a prior fetch's query (pick from a list fetched for "octocat" leaves `value` as "octocat" too), so only
      // clearing the pairing - not just relying on a query mismatch - keeps the list closed right after a pick.
      setResult(null);
      setOpen(false);
      setLookup(null);
      return;
    }

    const cached = cache[query.toLowerCase()];
    if (cached) {
      setResult({ query, options: cached });
      setLookup(null);
      setOpen(focusedRef.current);
      return;
    }

    // Announce the pending query right away so the box never looks idle while debouncing, but only actually
    // ask the route once the user stops typing for a beat.
    setLookup({ status: "loading" });
    const timer = setTimeout(() => startLookup(query), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, noToken, picked, cache, startLookup]);

  // Belt and suspenders: whatever is in flight is abandoned the instant the box itself goes away.
  useEffect(() => () => pendingRef.current?.controller.abort(), []);
  useEffect(() => () => {
    if (shieldTimer.current) clearTimeout(shieldTimer.current);
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  const excludedSet = new Set(exclude.map((login) => login.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
  // Only an answer fetched for the *current* query counts: this is what stops a keydown from ever picking a
  // suggestion fetched for text the user has since changed (the effect above that would otherwise clear a
  // stale `result` runs asynchronously, after the render that changed `value`/`query` - this check does not
  // depend on that effect having run yet, since it recomputes on every render from the two state values).
  //
  // `result` itself lags one render behind `query` on a cache hit too: the effect above is what actually
  // copies the cache's answer into `result`, so the very render where a keystroke lands on an already-cached
  // prefix still has `result.query` pointing at the *previous* query. Reading `cache` here as a fallback —
  // synchronously, in render, not only once the effect has run — is what keeps the list from ever going
  // empty for a single frame on that keystroke. It never races `result`: a `result` that already matches
  // `query` (including one deliberately set to an empty answer, e.g. the rate-limited path) always wins over
  // the cache, so this only fills in the gap before the effect has caught up.
  const candidates = (() => {
    if (!query || noToken || query === picked) return [];
    const matching = result && result.query === query ? result.options : cache[query.toLowerCase()];
    return matching ? matching.filter((candidate) => !excludedSet.has(candidate.login.toLowerCase())).slice(0, SUGGEST_MAX) : [];
  })();
  const expanded = open && candidates.length > 0;
  // `active.query === query`, not just a bounds check: see the comment on `active`'s declaration above.
  const activeIndex = active.query === query && active.index >= 0 && active.index < candidates.length ? active.index : -1;
  /** Sets the active option, paired with the query it belongs to (see `active` above). */
  const setActive = (index: number) => setActiveState({ query, index });

  const pick = (login: string, options?: { viaPointer?: boolean }) => {
    if (options?.viaPointer) {
      setShieldedCandidates(candidates);
      setShielding(true);
      if (shieldTimer.current) clearTimeout(shieldTimer.current);
      shieldTimer.current = setTimeout(() => setShielding(false), SHIELD_MS);
    }
    onChange(login);
    setPicked(login);
    setOpen(false);
    setActive(-1);
    onPick?.(login);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!expanded) {
      // The list was closed (by Escape or a blur/refocus); re-show the cached candidates without asking again.
      if (event.key === "ArrowDown" && candidates.length > 0) {
        event.preventDefault();
        setOpen(true);
        setActive(0);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveState((prev) => {
          const current = prev.query === query ? prev.index : -1;
          return { query, index: current + 1 >= candidates.length ? 0 : current + 1 };
        });
        return;
      case "ArrowUp":
        event.preventDefault();
        setActiveState((prev) => {
          const current = prev.query === query ? prev.index : -1;
          return { query, index: current <= 0 ? candidates.length - 1 : current - 1 };
        });
        return;
      case "Home":
        event.preventDefault();
        setActive(0);
        return;
      case "End":
        event.preventDefault();
        setActive(candidates.length - 1);
        return;
      case "Enter":
        // Only claim Enter when an option is actually active; otherwise let the form submit the typed handle.
        if (activeIndex >= 0) {
          event.preventDefault();
          pick(candidates[activeIndex]!.login);
        } else {
          // The typed handle is the choice: close the list so whatever the dialog answers under the field (an
          // error, "already has access") is not hidden behind suggestions for other people. ArrowDown reopens it.
          setOpen(false);
        }
        return;
      case "Escape":
        // First Escape closes the list and nothing else; a second Escape (list already closed) reaches the dialog.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setActive(-1);
        return;
      default:
        return;
    }
  };

  const handleBlur = () => {
    focusedRef.current = false;
    // Deferred, not synchronous: unmounting the listbox (setOpen(false) below) in the very same tick as blur
    // races the browser's own default action for whatever caused the blur — Tab's native focus-move, or a
    // mousedown on another control that's still resolving its own click. The browser can compute "where focus
    // goes next" from the DOM as it stood at blur time, but if that DOM changes (the listbox disappears)
    // before the move actually completes, focus lands on the nearest focusable ancestor instead — here, the
    // dialog's own focus-trap container — rather than the role select, Add button, or whatever was clicked.
    // A macrotask lets the browser finish moving focus first; the `focusedRef` check cancels the close if the
    // box was refocused before the timer fires (e.g. Shift+Tab straight back in), so it is never force-closed
    // out from under a user who is still in it.
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      blurTimer.current = null;
      if (focusedRef.current) return;
      setOpen(false);
      setActive(-1);
    }, 0);
  };

  // Refocusing the box (tab back in, or dismiss-and-return) shows the already-fetched candidates again
  // without asking the route a second time for the same query.
  const handleFocus = () => {
    focusedRef.current = true;
    if (candidates.length > 0) setOpen(true);
  };

  const handleRetry = () => {
    if (!query || lookup?.status !== "error" || lookup.retrying) return; // ignore a press while already retrying
    setLookup({ ...lookup, retrying: true });
    startLookup(query, { manualRetry: true });
  };

  return (
    <div className="relative flex-1">
      <UserPlus size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
      <input
        ref={inputRef}
        className="input pl-9"
        placeholder="GitHub handle, e.g. octocat"
        aria-label="GitHub handle"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={handleFocus}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        aria-describedby={lookup ? feedbackId : undefined}
        autoComplete="off"
        spellCheck={false}
        data-testid="share-login"
      />
      {lookup?.status === "loading" && (
        <div
          id={feedbackId}
          className="mt-1 flex items-center gap-1.5 text-xs text-ink-3"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="share-login-loading"
        >
          <Loader2 size={12} className="animate-spin" aria-hidden />
          Loading GitHub suggestions for @{query}…
        </div>
      )}
      {lookup?.status === "error" && (
        <div
          id={feedbackId}
          className="mt-1 flex items-center gap-2 text-xs text-danger"
          role="alert"
          aria-atomic="true"
          data-testid="share-login-error"
        >
          <span className="min-w-0 flex-1">{lookup.message}</span>
          <button
            ref={retryButtonRef}
            type="button"
            className="btn btn-outline btn-sm h-6 shrink-0 px-2"
            onClick={handleRetry}
            onBlur={handleBlur}
            // aria-disabled, not disabled: disabling the focused button while the request is in flight would
            // drop focus to <body> (same issue as the link-preview switch elsewhere in share-dialog.tsx), and
            // after a failed retry it would stay there with nothing focused. handleRetry already ignores a
            // press while retrying, so the button can safely stay focusable and in the DOM throughout.
            aria-disabled={lookup.retrying || undefined}
            aria-busy={lookup.retrying || undefined}
          >
            {lookup.retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {expanded && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching GitHub accounts"
          className="menu absolute left-0 right-0 top-full mt-1 max-h-80 overflow-y-auto"
          data-testid="share-login-suggestions"
        >
          {candidates.map((candidate, index) => (
            <li
              key={candidate.login}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cn("menu-item py-1.5", index === activeIndex && "bg-surface-3")}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={(event) => {
                // A resting pointer never fires `mousemove` on its own — only a genuine move does — but
                // compare coordinates too, defensively, in case some future browser quirk dispatches one
                // without real movement (measured on Chromium: it does not, as of this fix).
                const last = lastPointerPosRef.current;
                if (last && last.x === event.clientX && last.y === event.clientY) return;
                lastPointerPosRef.current = { x: event.clientX, y: event.clientY };
                setActive(index);
              }}
              onClick={() => pick(candidate.login, { viaPointer: true })}
              data-testid="share-login-option"
              data-login={candidate.login}
            >
              <span aria-hidden>
                <SuggestionAvatar login={candidate.login} src={candidate.avatarUrl} />
              </span>
              {candidate.name && (
                <span className="min-w-0 truncate text-[13px] text-ink" title={candidate.name}>
                  {candidate.name}
                </span>
              )}
              <span
                title={`@${candidate.login}`}
                className={cn("min-w-0 truncate", candidate.name ? "text-xs text-ink-3" : "text-[13px] text-ink")}
              >
                @{candidate.login}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!expanded && shielding && shieldedCandidates.length > 0 && (
        // Not a real listbox: just-picked candidates' footprint, held in place and non-interactive for a beat
        // so a fast second click (a double-click or double-tap finishing after the pick already closed the
        // real list) lands here and does nothing, instead of falling through to the role select or a
        // collaborator row. onMouseDown prevents the default too, so this second click never moves focus off
        // wherever the pick itself already sent it (the role select).
        <ul
          aria-hidden="true"
          className="menu absolute left-0 right-0 top-full mt-1 max-h-80 overflow-y-auto"
          onMouseDown={(event) => event.preventDefault()}
          onPointerLeave={(event) => {
            // A touch's own pointerup fires pointerleave moments later (observed 13-30ms), which would end the
            // shield while a fast triple-tap's third tap is still in flight — well inside SHIELD_MS. Mouse pointers
            // don't have that quirk (the pointer only leaves once the user actually moves it away), so only a
            // mouse pointer ends the shield early; touch and pen rely on the SHIELD_MS timer alone.
            if (event.pointerType === "mouse") setShielding(false);
          }}
          data-testid="share-login-shield"
        >
          {shieldedCandidates.map((candidate) => (
            <li key={candidate.login} className="menu-item py-1.5">
              <span>
                <SuggestionAvatar login={candidate.login} src={candidate.avatarUrl} />
              </span>
              {candidate.name && <span className="min-w-0 truncate text-[13px] text-ink">{candidate.name}</span>}
              <span className={cn("min-w-0 truncate", candidate.name ? "text-xs text-ink-3" : "text-[13px] text-ink")}>
                @{candidate.login}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
