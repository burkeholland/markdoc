"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/hooks";
import { isThemePreference, nextTheme, setThemePreference, themeLabel, themeStore, type ThemePreference } from "@/lib/theme";

interface ThemeAuthority {
  preference: ThemePreference;
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getServerSnapshot);
  const authority = useMemo<ThemeAuthority>(() => ({ preference }), [preference]);
  const authorityRef = useRef<ThemeAuthority | null>(null);

  useLayoutEffect(() => {
    authorityRef.current = authority;
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
    };
  }, [authority]);

  const setPreference = useCallback((next: ThemePreference) => {
    if (
      authorityRef.current !== authority
      || !isThemePreference(next)
      || next === authority.preference
      || themeStore.getSnapshot() !== authority.preference
    )
      return;
    setThemePreference(next);
  }, [authority]);

  return [preference, setPreference];
}

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const ICON_NAMES = { system: "monitor", light: "sun", dark: "moon" } as const;
const THEME_OPTIONS = ["system", "light", "dark"] as const;
const PICKER_CLASS_NAME = "inline-flex rounded-lg border border-line-2 bg-surface p-0.5";
const PICKER_ROW_BASE_CLASS_NAME =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors";
const PICKER_ROW_ACTIVE_CLASS_NAME = "bg-accent-soft text-accent font-medium";
const PICKER_ROW_INACTIVE_CLASS_NAME = "text-ink-2 hover:bg-surface-3 hover:text-ink";

class CurrentCell<T> {
  constructor(public current: T) {}
}

class ElementOwner<T extends Element> {
  private current: T | null = null;
  private last: T | null = null;

  constructor(private readonly onReplacement: () => void) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const replaced = element !== null && this.last !== null && this.last !== element;
    this.current = element;
    if (element) this.last = element;
    if (replaced || element === null) this.onReplacement();
  };
}

function iconMatches(
  icon: SVGSVGElement,
  parent: HTMLButtonElement,
  preference: ThemePreference,
  size: number,
): boolean {
  return (
    icon.isConnected
    && icon.ownerDocument === parent.ownerDocument
    && icon.parentElement === parent
    && parent.children.length === 1
    && parent.firstElementChild === icon
    && icon.tagName.toLowerCase() === "svg"
    && icon.classList.contains(`lucide-${ICON_NAMES[preference]}`)
    && icon.getAttribute("width") === String(size)
    && icon.getAttribute("height") === String(size)
    && icon.getAttribute("aria-hidden") === "true"
  );
}

function exactNativeClick(
  event: ReactMouseEvent<HTMLButtonElement>,
  control: HTMLButtonElement,
): MouseEvent | null {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = control.ownerDocument;
  const view = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  return (
    view
    && event.type === "click"
    && nativeEvent instanceof view.MouseEvent
    && nativeEvent.type === "click"
    && event.currentTarget === control
    && nativeEvent.target === target
    && target instanceof view.Node
    && target.ownerDocument === ownerDocument
    && control.contains(target)
  )
    ? nativeEvent
    : null;
}

interface ToggleAuthority {
  readonly mount: symbol;
  readonly preference: ThemePreference;
  readonly nextPreference: ThemePreference;
  readonly setPreference: (next: ThemePreference) => void;
  readonly hydrated: boolean;
  readonly label: string;
  readonly title: string;
  readonly classNameInput: string | undefined;
  readonly className: string;
  readonly size: number;
}

interface ToggleCells {
  readonly active: CurrentCell<TogglePresentation | null>;
  readonly claimedEvents: WeakSet<object>;
}

interface TogglePresentation {
  readonly authority: ToggleAuthority;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly captureIcon: (element: SVGSVGElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function createTogglePresentation(authority: ToggleAuthority, cells: ToggleCells): TogglePresentation {
  const {
    mount,
    preference,
    nextPreference,
    setPreference,
    hydrated,
    label,
    title,
    classNameInput,
    className,
    size,
  } = authority;
  let markup: string | null = null;
  const retireForReplacement = () => presentation.retire();
  const buttonOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
  const iconOwner = new ElementOwner<SVGSVGElement>(retireForReplacement);
  const factsAreCurrent = () =>
    authority.mount === mount
    && authority.preference === preference
    && authority.nextPreference === nextPreference
    && authority.setPreference === setPreference
    && authority.hydrated === hydrated
    && authority.label === label
    && authority.title === title
    && authority.classNameInput === classNameInput
    && authority.className === className
    && authority.size === size
    && nextPreference === nextTheme(preference)
    && label === `Theme: ${themeLabel(preference)}`
    && title === `${label} (click to switch)`
    && className === cn("icon-btn", classNameInput);
  const exactDomIsCurrent = () => {
    const button = buttonOwner.element();
    const icon = iconOwner.element();
    return (
      hydrated
      && !!button
      && !!icon
      && button.isConnected
      && button.tagName === "BUTTON"
      && button.getAttribute("type") === "button"
      && button.type === "button"
      && !button.disabled
      && !button.matches(":disabled")
      && button.getAttribute("aria-busy") === null
      && button.getAttribute("aria-label") === label
      && button.getAttribute("title") === title
      && button.getAttribute("class") === className
      && button.dataset.testid === "theme-toggle"
      && button.dataset.themePreference === preference
      && button.childNodes.length === 1
      && iconMatches(icon, button, preference, size)
      && (markup === null || button.outerHTML === markup)
    );
  };
  const retire = () => {
    if (cells.active.current !== presentation) return false;
    cells.active.current = null;
    return true;
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== presentation) previous.retire();
    if (!factsAreCurrent() || !exactDomIsCurrent()) return;
    const button = buttonOwner.element();
    if (!button) return;
    markup ??= button.outerHTML;
    cells.active.current = presentation;
  };
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const button = buttonOwner.element();
    if (
      cells.active.current !== presentation
      || !factsAreCurrent()
      || !exactDomIsCurrent()
      || !button
      || themeStore.getSnapshot() !== preference
    ) {
      return;
    }
    const nativeEvent = exactNativeClick(event, button);
    if (!nativeEvent || cells.claimedEvents.has(nativeEvent)) return;
    cells.claimedEvents.add(nativeEvent);
    setPreference(nextPreference);
  };

  const presentation: TogglePresentation = Object.freeze({
    authority,
    captureButton: buttonOwner.capture,
    captureIcon: iconOwner.capture,
    establish,
    retire,
    onClick,
  });
  return presentation;
}

interface PickerAuthority {
  readonly mount: symbol;
  readonly preference: ThemePreference;
  readonly setPreference: (next: ThemePreference) => void;
  readonly rootClassName: string;
}

interface PickerCells {
  readonly active: CurrentCell<PickerPresentation | null>;
  readonly claimedEvents: WeakSet<object>;
}

interface PickerRowPresentation {
  readonly preference: ThemePreference;
  readonly label: string;
  readonly checked: boolean;
  readonly className: string;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly captureIcon: (element: SVGSVGElement | null) => void;
  readonly button: () => HTMLButtonElement | null;
  readonly icon: () => SVGSVGElement | null;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface PickerPresentation {
  readonly authority: PickerAuthority;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly rows: readonly PickerRowPresentation[];
  readonly establish: () => void;
  readonly retire: () => boolean;
}

function createPickerPresentation(authority: PickerAuthority, cells: PickerCells): PickerPresentation {
  const { mount, preference, setPreference, rootClassName } = authority;
  let markup: string | null = null;
  const retireForReplacement = () => presentation.retire();
  const rootOwner = new ElementOwner<HTMLDivElement>(retireForReplacement);
  const rows = THEME_OPTIONS.map((rowPreference) => {
    const label = themeLabel(rowPreference);
    const checked = rowPreference === preference;
    const className = cn(
      PICKER_ROW_BASE_CLASS_NAME,
      checked ? PICKER_ROW_ACTIVE_CLASS_NAME : PICKER_ROW_INACTIVE_CLASS_NAME,
    );
    const buttonOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
    const iconOwner = new ElementOwner<SVGSVGElement>(retireForReplacement);
    const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
      const button = buttonOwner.element();
      if (
        row.checked
        || row.preference === preference
        || cells.active.current !== presentation
        || !factsAreCurrent()
        || !exactDomIsCurrent()
        || !button
        || themeStore.getSnapshot() !== preference
      ) {
        return;
      }
      const nativeEvent = exactNativeClick(event, button);
      if (!nativeEvent || cells.claimedEvents.has(nativeEvent)) return;
      cells.claimedEvents.add(nativeEvent);
      setPreference(rowPreference);
    };
    const row: PickerRowPresentation = Object.freeze({
      preference: rowPreference,
      label,
      checked,
      className,
      captureButton: buttonOwner.capture,
      captureIcon: iconOwner.capture,
      button: buttonOwner.element,
      icon: iconOwner.element,
      onClick,
    });
    return row;
  });
  const factsAreCurrent = () =>
    authority.mount === mount
    && authority.preference === preference
    && authority.setPreference === setPreference
    && authority.rootClassName === rootClassName
    && rootClassName === PICKER_CLASS_NAME
    && rows.length === THEME_OPTIONS.length
    && rows.every((row, index) => (
      row.preference === THEME_OPTIONS[index]
      && row.label === themeLabel(row.preference)
      && row.checked === (row.preference === preference)
      && row.className === cn(
        PICKER_ROW_BASE_CLASS_NAME,
        row.checked ? PICKER_ROW_ACTIVE_CLASS_NAME : PICKER_ROW_INACTIVE_CLASS_NAME,
      )
    ));
  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    return (
      !!root
      && root.isConnected
      && root.tagName === "DIV"
      && root.getAttribute("class") === rootClassName
      && root.getAttribute("role") === "radiogroup"
      && root.getAttribute("aria-label") === "Theme"
      && root.dataset.testid === "theme-picker"
      && root.children.length === THEME_OPTIONS.length
      && root.childNodes.length === THEME_OPTIONS.length
      && rows.every((row, index) => {
        const button = row.button();
        const icon = row.icon();
        return (
          !!button
          && !!icon
          && button.isConnected
          && button.ownerDocument === root.ownerDocument
          && button.tagName === "BUTTON"
          && button.parentElement === root
          && root.children.item(index) === button
          && button.getAttribute("type") === "button"
          && button.type === "button"
          && !button.disabled
          && !button.matches(":disabled")
          && button.getAttribute("role") === "radio"
          && button.getAttribute("aria-checked") === String(row.checked)
          && button.getAttribute("class") === row.className
          && button.dataset.testid === `theme-option-${row.preference}`
          && button.textContent?.trim() === row.label
          && iconMatches(icon, button, row.preference, 14)
        );
      })
      && (markup === null || root.outerHTML === markup)
    );
  };
  const retire = () => {
    if (cells.active.current !== presentation) return false;
    cells.active.current = null;
    return true;
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== presentation) previous.retire();
    if (!factsAreCurrent() || !exactDomIsCurrent()) return;
    const root = rootOwner.element();
    if (!root) return;
    markup ??= root.outerHTML;
    cells.active.current = presentation;
  };

  const presentation: PickerPresentation = Object.freeze({
    authority,
    captureRoot: rootOwner.capture,
    rows: Object.freeze(rows),
    establish,
    retire,
  });
  return presentation;
}

/**
 * Cycles system → light → dark. The server renders the "system" icon; the client corrects it after
 * hydration. The button is `disabled` (and `aria-busy`) until then: the server markup has no click
 * handler, so a click that lands before React hydrates would be silently lost. Disabling it makes
 * Playwright's actionability check wait, and tells assistive tech the control is not ready yet.
 */
export function ThemeToggle({ className, size = 16 }: { className?: string; size?: number }) {
  const [preference, setPreference] = useTheme();
  const hydrated = useHydrated();
  const [mount] = useState(() => Symbol("theme toggle"));
  const [cells] = useState<ToggleCells>(() => ({
    active: new CurrentCell<TogglePresentation | null>(null),
    claimedEvents: new WeakSet<object>(),
  }));
  const Icon = ICONS[preference];
  const label = `Theme: ${themeLabel(preference)}`;
  const title = `${label} (click to switch)`;
  const buttonClassName = cn("icon-btn", className);
  const presentation = useMemo(
    () => createTogglePresentation(
      Object.freeze({
        mount,
        preference,
        nextPreference: nextTheme(preference),
        setPreference,
        hydrated,
        label,
        title,
        classNameInput: className,
        className: buttonClassName,
        size,
      }),
      cells,
    ),
    [buttonClassName, cells, className, hydrated, label, mount, preference, setPreference, size, title],
  );

  useLayoutEffect(() => {
    presentation.establish();
    return () => {
      presentation.retire();
    };
  }, [presentation]);
  const { captureButton, captureIcon, onClick } = presentation;

  return (
    <button
      ref={captureButton}
      type="button"
      className={buttonClassName}
      onClick={onClick}
      disabled={!hydrated}
      aria-busy={!hydrated || undefined}
      title={title}
      aria-label={label}
      data-testid="theme-toggle"
      data-theme-preference={preference}
    >
      <Icon ref={captureIcon} size={size} />
    </button>
  );
}

/** Radio-style row for the settings page. */
export function ThemePicker() {
  const [preference, setPreference] = useTheme();
  const [mount] = useState(() => Symbol("theme picker"));
  const [cells] = useState<PickerCells>(() => ({
    active: new CurrentCell<PickerPresentation | null>(null),
    claimedEvents: new WeakSet<object>(),
  }));
  const presentation = useMemo(
    () => createPickerPresentation(
      Object.freeze({
        mount,
        preference,
        setPreference,
        rootClassName: PICKER_CLASS_NAME,
      }),
      cells,
    ),
    [cells, mount, preference, setPreference],
  );

  useLayoutEffect(() => {
    presentation.establish();
    return () => {
      presentation.retire();
    };
  }, [presentation]);
  const { captureRoot, rows } = presentation;

  return (
    <div
      ref={captureRoot}
      className={PICKER_CLASS_NAME}
      role="radiogroup"
      aria-label="Theme"
      data-testid="theme-picker"
    >
      {rows.map((row) => {
        const option = row.preference;
        const Icon = ICONS[option];
        return (
          <button
            ref={row.captureButton}
            key={option}
            type="button"
            role="radio"
            aria-checked={row.checked}
            className={row.className}
            onClick={row.onClick}
            data-testid={`theme-option-${option}`}
          >
            <Icon ref={row.captureIcon} size={14} /> {row.label}
          </button>
        );
      })}
    </div>
  );
}
