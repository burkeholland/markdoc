"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/hooks";
import { nextTheme, setThemePreference, themeLabel, themeStore, type ThemePreference } from "@/lib/theme";

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getServerSnapshot);
  return [preference, setThemePreference];
}

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/**
 * Cycles system → light → dark. The server renders the "system" icon; the client corrects it after
 * hydration. The button is `disabled` (and `aria-busy`) until then: the server markup has no click
 * handler, so a click that lands before React hydrates would be silently lost. Disabling it makes
 * Playwright's actionability check wait, and tells assistive tech the control is not ready yet.
 */
export function ThemeToggle({ className, size = 16 }: { className?: string; size?: number }) {
  const [preference, setPreference] = useTheme();
  const hydrated = useHydrated();
  const Icon = ICONS[preference];
  const label = `Theme: ${themeLabel(preference)}`;
  return (
    <button
      type="button"
      className={cn("icon-btn", className)}
      onClick={() => setPreference(nextTheme(preference))}
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
  const [preference, setPreference] = useTheme();
  const options: ThemePreference[] = ["system", "light", "dark"];
  return (
    <div className="inline-flex rounded-lg border border-line-2 bg-surface p-0.5" role="radiogroup" aria-label="Theme" data-testid="theme-picker">
      {options.map((option) => {
        const Icon = ICONS[option];
        const active = option === preference;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors",
              active ? "bg-accent-soft text-accent font-medium" : "text-ink-2 hover:bg-surface-3 hover:text-ink",
            )}
            onClick={() => setPreference(option)}
            data-testid={`theme-option-${option}`}
          >
            <Icon size={14} /> {themeLabel(option)}
          </button>
        );
      })}
    </div>
  );
}
