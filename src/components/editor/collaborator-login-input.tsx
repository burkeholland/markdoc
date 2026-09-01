"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { UserPlus } from "lucide-react";
import { api, type GitHubUserDto } from "@/lib/api";
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

/**
 * The Share dialog's handle box with GitHub-account suggestions: an ARIA combobox over a listbox of
 * up to eight `@login`s that appears once two login characters have settled for 250 ms. ↓/↑ move,
 * Enter picks the active option (with none active it submits the typed handle as before), Escape
 * closes the list (the dialog stays open), a click picks. Picking fills the box and calls `onPick` so
 * the owner lands on the role select and still presses Add. Anything GitHub cannot answer — a
 * rate-limited search, no token, a network error — shows nothing: adding by exact handle never breaks.
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<GitHubUserDto[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Every query change bumps `seq`; a response whose seq is no longer current is dropped.
  const seq = useRef(0);
  const cache = useRef(new Map<string, GitHubUserDto[]>());
  // The login a pick just wrote into the box: it is not searched again (its owner is about to press Add).
  const picked = useRef<string | null>(null);
  // Set once the route answered `reason: "no-github-token"`: this session cannot search, so no further request goes out while mounted.
  const noToken = useRef(false);
  const query = suggestQuery(value);

  useEffect(() => {
    const current = ++seq.current;
    const show = (users: GitHubUserDto[]) => {
      setOptions(users);
      setActive(-1);
      // A late answer must not pop the list open under a box that was already left.
      setOpen(users.length > 0 && document.activeElement === inputRef.current);
    };
    if (!query || query === picked.current || noToken.current) {
      show([]);
      return;
    }
    const cached = cache.current.get(query.toLowerCase());
    if (cached) {
      show(cached);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.github
        .searchUsers(query, { signal: controller.signal })
        .then((res) => {
          // "No token" is true of the session, not of this query: even a superseded answer settles it.
          if (res.reason === "no-github-token") noToken.current = true;
          if (seq.current !== current) return;
          if (noToken.current) {
            show([]);
            return;
          }
          if (!res.limited) cache.current.set(query.toLowerCase(), res.users);
          show(res.limited ? [] : res.users);
        })
        .catch(() => {
          if (seq.current === current) show([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const excluded = new Set(exclude.map((l) => l.toLowerCase()));
  const visible = options.filter((u) => !excluded.has(u.login.toLowerCase())).slice(0, SUGGEST_MAX);
  const expanded = open && visible.length > 0;
  const activeIndex = active < visible.length ? active : -1;
  const optionId = (i: number) => `${listId}-option-${i}`;

  const pick = (user: GitHubUserDto) => {
    picked.current = user.login;
    onChange(user.login);
    setOpen(false);
    setActive(-1);
    onPick?.(user.login);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = visible.length;
      if (n === 0) return;
      e.preventDefault();
      setOpen(true);
      setActive(e.key === "ArrowDown" ? (activeIndex + 1) % n : activeIndex <= 0 ? n - 1 : activeIndex - 1);
      return;
    }
    if (e.key === "Enter" && expanded && activeIndex >= 0) {
      e.preventDefault();
      pick(visible[activeIndex]);
      return;
    }
    if (e.key === "Escape" && expanded) {
      // DialogContent leaves this Escape to the expanded combobox (see primitives.tsx), so only the list closes.
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
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
        onChange={(e) => {
          picked.current = null;
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (visible.length > 0) setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        spellCheck={false}
        data-testid="share-login"
      />
      {expanded && (
        <ul id={listId} role="listbox" aria-label="Matching GitHub accounts" className="menu absolute left-0 right-0 top-full mt-1 max-h-80 overflow-y-auto" data-testid="share-login-suggestions">
          {visible.map((u, i) => (
            <li
              key={u.login}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              className={cn("menu-item py-1.5", i === activeIndex && "bg-surface-3")}
              // Keep focus (and the list) in place while the pointer is down; the click then picks.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(u)}
              data-testid="share-login-option"
              data-login={u.login}
            >
              <span aria-hidden>
                <Avatar name={u.login} src={u.avatarUrl} size={20} />
              </span>
              {u.name && <span className="min-w-0 truncate text-[13px] text-ink">{u.name}</span>}
              <span className={cn("min-w-0 truncate", u.name ? "text-xs text-ink-3" : "text-[13px] text-ink")}>@{u.login}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
