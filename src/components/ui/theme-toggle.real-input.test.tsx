// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemePicker, ThemeToggle } from "./theme-toggle";

const data = new Map<string, string>();

beforeEach(() => {
  data.clear();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "localStorage");
  Reflect.deleteProperty(window, "matchMedia");
});

it("ThemeToggle honors a synthetic click and a userEvent click", async () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByTestId("theme-toggle"));
  expect(data.get(THEME_STORAGE_KEY)).toBe("light");
  await userEvent.click(screen.getByTestId("theme-toggle"));
  expect(data.get(THEME_STORAGE_KEY)).toBe("dark");
});

it("ThemePicker honors userEvent clicks and arrow keys", async () => {
  render(<ThemePicker />);
  await userEvent.click(screen.getByTestId("theme-option-dark"));
  expect(data.get(THEME_STORAGE_KEY)).toBe("dark");
  await userEvent.keyboard("{ArrowLeft}");
  expect(data.get(THEME_STORAGE_KEY)).toBe("light");
  expect(document.activeElement).toBe(screen.getByTestId("theme-option-light"));
});
