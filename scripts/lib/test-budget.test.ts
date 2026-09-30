import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetMs, budgetScale } from "./test-budget";

afterEach(() => vi.unstubAllEnvs());

describe("shared timing budgets", () => {
  it.each([
    { scale: undefined, ci: undefined, expected: 1 },
    { scale: undefined, ci: "1", expected: 3 },
    { scale: "2", ci: undefined, expected: 2 },
    { scale: "1", ci: "1", expected: 1 },
    { scale: "1.5", ci: undefined, expected: 1.5 },
    { scale: "0.5", ci: undefined, expected: 1 },
    { scale: "-1", ci: "1", expected: 3 },
    { scale: "NaN", ci: undefined, expected: 1 },
    { scale: "Infinity", ci: "1", expected: 3 },
  ])("uses $expected for scale=$scale and CI=$ci", ({ scale, ci, expected }) => {
    vi.stubEnv("E2E_BUDGET_SCALE", scale);
    vi.stubEnv("CI", ci);
    expect(budgetScale()).toBe(expected);
    expect(budgetMs(180_000)).toBe(180_000 * expected);
    expect(budgetMs(60_000)).toBe(60_000 * expected);
    expect(budgetMs(3)).toBe(Math.round(3 * expected));
  });
});
