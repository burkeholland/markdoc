/**
 * Theme preference: "system" follows `prefers-color-scheme`, the others pin it. The resolved
 * value is written to `<html data-theme>` — first by the inline boot script in layout.tsx
 * (before hydration, so there is no flash), then by `applyTheme` whenever the preference or the
 * OS setting changes. CSS reads the attribute in globals.css.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "markdoc:theme";
export const THEME_ORDER: readonly ThemePreference[] = ["system", "light", "dark"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/** system → light → dark → system. */
export function nextTheme(preference: ThemePreference): ThemePreference {
  const i = THEME_ORDER.indexOf(preference);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

export function themeLabel(preference: ThemePreference): string {
  return preference === "system" ? "System" : preference === "light" ? "Light" : "Dark";
}

/**
 * Runs before hydration from a `<script>` in the root layout. Kept as a string (not a function
 * reference) so Next inlines it verbatim; the unit test evaluates it against fake globals.
 */
export const THEME_BOOT_SCRIPT = `(function(){var k=${JSON.stringify(THEME_STORAGE_KEY)};var p;try{p=localStorage.getItem(k);}catch(e){p="system";}var d=p==="dark";if(p!=="light"&&p!=="dark"){try{d=window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches===true;}catch(e){d=false;}}document.documentElement.setAttribute("data-theme",d?"dark":"light");})();`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readThemePreference(): ThemePreference {
  try {
    const value = storage()?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function systemPrefersDark(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches === true;
  } catch {
    return false;
  }
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, preference === "system" && systemPrefersDark());
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", resolved);
  return resolved;
}

const listeners = new Set<() => void>();
let mediaBound = false;

function emit() {
  for (const fn of listeners) fn();
}

function bindMedia() {
  if (mediaBound || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaBound = true;
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (readThemePreference() === "system") applyTheme("system");
    emit();
  };
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else mq.addListener(onChange);
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_STORAGE_KEY || (e.key === null && e.storageArea !== null && e.storageArea === storage())) {
      applyTheme(readThemePreference());
      emit();
    }
  });
}

export function setThemePreference(preference: ThemePreference) {
  storage()?.setItem(THEME_STORAGE_KEY, preference);
  applyTheme(preference);
  emit();
}

/** Store shape for useSyncExternalStore; the snapshot is the preference string so it is stable. */
export const themeStore = {
  subscribe(fn: () => void) {
    bindMedia();
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: (): ThemePreference => readThemePreference(),
  getServerSnapshot: (): ThemePreference => "system",
};
