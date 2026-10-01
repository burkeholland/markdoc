/** Shared wall-clock allowance for browser timing assertions and long unit stress tests. */
export const budgetScale = (): number => {
  const raw = Number(process.env.E2E_BUDGET_SCALE);
  return Number.isFinite(raw) && raw >= 1 ? raw : process.env.CI ? 3 : 1;
};

export const budgetMs = (ms: number): number => Math.round(ms * budgetScale());
