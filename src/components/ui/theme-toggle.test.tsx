// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { THEME_STORAGE_KEY, setThemePreference, type ThemePreference } from "@/lib/theme";
import { ThemePicker, ThemeToggle } from "./theme-toggle";

function installStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return storage;
}

let storage: ReturnType<typeof installStorage>;

beforeEach(() => {
  storage = installStorage();
  document.documentElement.removeAttribute("data-theme");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "localStorage");
  Reflect.deleteProperty(window, "matchMedia");
});

const option = (preference: ThemePreference) => screen.getByTestId(`theme-option-${preference}`);

describe("ThemeToggle", () => {
  it("renders disabled and busy on the server until hydration", () => {
    const html = renderToString(<ThemeToggle />);
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });

  it("labels the current preference and cycles system → light → dark → system", () => {
    render(<ThemeToggle className="extra" size={18} />);
    const button = screen.getByTestId("theme-toggle");
    expect(button).toHaveAttribute("aria-label", "Theme: System");
    expect(button).toHaveAttribute("title", "Theme: System (click to switch)");
    expect(button).toHaveClass("icon-btn", "extra");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      fireEvent.click(button);
      seen.push(storage.getItem(THEME_STORAGE_KEY)!);
    }
    expect(seen).toEqual(["light", "dark", "system"]);
    expect(button).toHaveAttribute("data-theme-preference", "system");
  });

  it("follows a cross-tab storage change", () => {
    render(<ThemeToggle />);
    act(() => {
      storage.setItem(THEME_STORAGE_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("ThemePicker", () => {
  it("renders a radiogroup with one tab stop on the selected option", () => {
    act(() => setThemePreference("light"));
    render(<ThemePicker />);
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(option("light")).toHaveAttribute("aria-checked", "true");
    expect(option("light").tabIndex).toBe(0);
    expect(option("system").tabIndex).toBe(-1);
    expect(option("dark").tabIndex).toBe(-1);
    expect(screen.getAllByRole("radio").map((el) => el.textContent?.trim())).toEqual(["System", "Light", "Dark"]);
  });

  it("selects an option on click and moves the tab stop", () => {
    render(<ThemePicker />);
    fireEvent.click(option("dark"));
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(option("dark")).toHaveAttribute("aria-checked", "true");
    expect(option("dark").tabIndex).toBe(0);
  });

  it.each([
    ["ArrowRight", "system", "light"],
    ["ArrowDown", "light", "dark"],
    ["ArrowLeft", "dark", "light"],
    ["ArrowUp", "light", "system"],
    ["ArrowRight", "dark", "system"],
    ["ArrowLeft", "system", "dark"],
    ["Home", "dark", "system"],
    ["End", "system", "dark"],
  ] as const)("%s moves from %s to %s and focuses it", (key, from, to) => {
    act(() => setThemePreference(from));
    render(<ThemePicker />);
    option(from).focus();
    fireEvent.keyDown(option(from), { key });
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe(to);
    expect(document.activeElement).toBe(option(to));
  });

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)("leaves %s-modified arrows to the browser", (modifier) => {
    render(<ThemePicker />);
    const notPrevented = fireEvent.keyDown(option("system"), { key: "ArrowRight", [modifier]: true });
    expect(notPrevented).toBe(true);
    expect(option("system")).toHaveAttribute("aria-checked", "true");
  });

  it.each(["Tab", "Enter"])("does not prevent %s", (key) => {
    render(<ThemePicker />);
    expect(fireEvent.keyDown(option("system"), { key })).toBe(true);
    expect(option("system")).toHaveAttribute("aria-checked", "true");
  });

  it("leaves Home inert when already on the first option", () => {
    const setItem = vi.spyOn(storage, "setItem");
    render(<ThemePicker />);
    fireEvent.keyDown(option("system"), { key: "Home" });
    expect(setItem).not.toHaveBeenCalled();
  });
});
