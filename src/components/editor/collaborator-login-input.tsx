"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { Loader2, UserPlus } from "lucide-react";
import { api, apiErrorText, type GitHubUserDto } from "@/lib/api";
import { cn, initials } from "@/lib/utils";

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
  return q.length >= SUGGEST_MIN_CHARS && q.length <= 39 && /^[a-zA-Z0-9-]+$/.test(q) ? q : null;
}

/**
 * Whether a typed handle is a syntactically valid GitHub login (trimmed, `@` optional) — used to gate the
 * Add button. Matches exactly what POST /api/documents/[id]/collaborators accepts (1-39 chars, letters,
 * digits and hyphens, `@` optional) so Add is never stricter than the server — a login this short or shaped
 * can still be a real GitHub user even though it is too short to search suggestions for (see SUGGEST_MIN_CHARS).
 */
export function isValidLogin(value: string): boolean {
  const q = value.trim().replace(/^@/, "");
  return q.length >= 1 && q.length <= 39 && /^[a-zA-Z0-9-]+$/.test(q);
}

type Lookup = Readonly<{ status: "loading" } | { status: "error"; message: string; retrying: boolean }>;

type PendingRequest = Readonly<{ id: number; controller: AbortController }>;

export function CollaboratorLoginInput({
  value,
  onChange,
  exclude,
  onPick,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Logins already listed (the owner and every collaborator): never suggested again. */
  exclude: string[];
  /** Called after a suggestion fills the box, so the dialog can move focus on (e.g. to the role select). */
  onPick?: (login: string) => void;
}) {
  const listId = useId();
  const feedbackId = `${listId}-feedback`;
  const query = suggestQuery(value);

  const [options, setOptions] = useState<readonly GitHubUserDto[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
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
  const cacheRef = useRef(new Map<string, readonly GitHubUserDto[]>());
  const pendingRef = useRef<PendingRequest | null>(null);
  const nextRequestId = useRef(0);
  const [shieldedCandidates, setShieldedCandidates] = useState<readonly GitHubUserDto[]>([]);
  const shieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks real focus (set by the input's own focus/blur handlers) rather than reading
  // `document.activeElement`, which test harnesses can simulate without ever moving focus.
  const focusedRef = useRef(false);

  // Fetches one query, racing nothing but itself: a stale answer (superseded or aborted) is simply dropped.
  const startLookup = useCallback((q: string) => {
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
          setOptions([]);
          setOpen(false);
          setLookup({ status: "error", message: `GitHub suggestions for @${q} are temporarily unavailable.`, retrying: false });
          return;
        }
        const users = Object.freeze(result.users.slice());
        cacheRef.current.set(q.toLowerCase(), users);
        setOptions(users);
        setLookup(null);
        setOpen(focusedRef.current);
      })
      .catch((error: unknown) => {
        if (pendingRef.current?.id !== id) return;
        pendingRef.current = null;
        if (controller.signal.aborted) return;
        const reason = apiErrorText(error, "");
        setOptions([]);
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
    setActive(-1);

    if (!query || noToken || query === picked) {
      setOptions([]);
      setOpen(false);
      setLookup(null);
      return;
    }

    const cached = cacheRef.current.get(query.toLowerCase());
    if (cached) {
      setOptions(cached);
      setLookup(null);
      setOpen(focusedRef.current);
      return;
    }

    // Announce the pending query right away so the box never looks idle while debouncing, but only actually
    // ask the route once the user stops typing for a beat.
    setLookup({ status: "loading" });
    const timer = setTimeout(() => startLookup(query), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, noToken, picked, startLookup]);

  // Belt and suspenders: whatever is in flight is abandoned the instant the box itself goes away.
  useEffect(() => () => pendingRef.current?.controller.abort(), []);
  useEffect(() => () => {
    if (shieldTimer.current) clearTimeout(shieldTimer.current);
  }, []);

  const excludedSet = new Set(exclude.map((login) => login.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
  const candidates = options.filter((candidate) => !excludedSet.has(candidate.login.toLowerCase())).slice(0, SUGGEST_MAX);
  const expanded = open && candidates.length > 0;
  const activeIndex = active >= 0 && active < candidates.length ? active : -1;

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
        setActive((index) => (index + 1 >= candidates.length ? 0 : index + 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => (index <= 0 ? candidates.length - 1 : index - 1));
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
    setOpen(false);
    setActive(-1);
  };

  // Refocusing the box (tab back in, or dismiss-and-return) shows the already-fetched candidates again
  // without asking the route a second time for the same query.
  const handleFocus = () => {
    focusedRef.current = true;
    if (options.length > 0) setOpen(true);
  };

  const handleRetry = () => {
    if (!query) return;
    setLookup((current) => (current?.status === "error" ? { ...current, retrying: true } : current));
    startLookup(query);
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
            type="button"
            className="btn btn-outline btn-sm h-6 shrink-0 px-2"
            onClick={handleRetry}
            onBlur={handleBlur}
            disabled={lookup.retrying}
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
              onMouseOver={() => setActive(index)}
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
          onPointerLeave={() => setShielding(false)}
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
