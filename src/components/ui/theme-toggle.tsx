"use client";

import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/hooks";
import {
  isThemePreference,
  nextTheme,
  setThemePreference,
  themeLabel,
  themeStore,
  type ThemePreference,
} from "@/lib/theme";

function setPreference(next: ThemePreference) {
  if (!isThemePreference(next) || next === themeStore.getSnapshot()) return;
  setThemePreference(next);
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getServerSnapshot);
  return [preference, setPreference];
}

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_OPTIONS = ["system", "light", "dark"] as const;
const PICKER_CLASS_NAME = "inline-flex rounded-lg border border-line-2 bg-surface p-0.5";
const PICKER_ROW_BASE_CLASS_NAME =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors";
const PICKER_ROW_ACTIVE_CLASS_NAME = "bg-accent-soft text-accent font-medium";
const PICKER_ROW_INACTIVE_CLASS_NAME = "text-ink-2 hover:bg-surface-3 hover:text-ink";

const PICKER_NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]);

function pickerDestination(key: string, current: number, count: number): number | null {
  if (count < 2 || current < 0 || current >= count) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") return current === count - 1 ? null : count - 1;
  return null;
}

/**
 * Cycles system → light → dark. The server renders the "system" icon; the client corrects it after
 * hydration. The button is `disabled` (and `aria-busy`) until then: the server markup has no click
 * handler, so a click that lands before React hydrates would be silently lost. Disabling it makes
 * Playwright's actionability check wait, and tells assistive tech the control is not ready yet.
 */
export function ThemeToggle({ className, size = 16 }: { className?: string; size?: number }) {
  const [preference, setTheme] = useTheme();
  const hydrated = useHydrated();
  const Icon = ICONS[preference];
  const label = `Theme: ${themeLabel(preference)}`;

  return (
    <button
      type="button"
      className={cn("icon-btn", className)}
      onClick={() => setTheme(nextTheme(preference))}
      disabled={!hydrated}
      aria-busy={!hydrated || undefined}
      title={`${label} (click to switch)`}
      aria-label={label}
      data-testid="theme-toggle"
      data-theme-preference={preference}
    >
      <Icon size={size} />
    </button>
  );
}

/** Radio-style row for the settings page. */
export function ThemePicker() {
  const [preference, setTheme] = useTheme();
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!PICKER_NAVIGATION_KEYS.has(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const focused = options.indexOf(event.target as HTMLButtonElement);
    const destination = pickerDestination(event.key, focused >= 0 ? focused : THEME_OPTIONS.indexOf(preference), THEME_OPTIONS.length);
    if (destination === null) return;
    setTheme(THEME_OPTIONS[destination]!);
    options[destination]?.focus({ preventScroll: true });
  };

  return (
    <div
      className={PICKER_CLASS_NAME}
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      data-testid="theme-picker"
    >
      {THEME_OPTIONS.map((option) => {
        const Icon = ICONS[option];
        const checked = option === preference;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={cn(PICKER_ROW_BASE_CLASS_NAME, checked ? PICKER_ROW_ACTIVE_CLASS_NAME : PICKER_ROW_INACTIVE_CLASS_NAME)}
            onClick={() => setTheme(option)}
            data-testid={`theme-option-${option}`}
          >
            <Icon size={14} /> {themeLabel(option)}
          </button>
        );
      })}
    </div>
  );
}
