import { expect, test } from "./fixtures";
import { signIn } from "./helpers";

/**
 * The API limiter end to end. The e2e dev server runs with `RATE_LIMIT=off` (the Burke-scale fixture
 * seeds through the API), so this spec only runs when the environment says `RATE_LIMIT=on`:
 * `RATE_LIMIT=on npx playwright test e2e/rate-limit.spec.ts`. The budgets themselves are covered by
 * src/server/http.test.ts; production keeps the limiter on (e2e/prod-smoke.spec.ts).
 */
test.describe("API rate limiting", () => {
  test.skip(process.env.RATE_LIMIT !== "on", "needs the dev server started with RATE_LIMIT=on");

  test("a 100-request burst from one session gets 429s with Retry-After while health keeps answering", async ({ browser }) => {
    const user = await signIn(browser, "burst-user");

    const first = await user.page.request.get("/api/me");
    expect(first.status()).toBe(200);
    expect(first.headers()["x-ratelimit-limit"]).toMatch(/^\d+$/);
    expect(first.headers()["x-ratelimit-remaining"]).toMatch(/^\d+$/);

    const health = (async () => {
      const t0 = Date.now();
      const res = await user.page.request.get("/api/health");
      return { status: res.status(), ms: Date.now() - t0, headers: res.headers() };
    })();
    const responses = await Promise.all(Array.from({ length: 100 }, () => user.page.request.get("/api/me")));
    const statuses = responses.map((r) => r.status());
    const refused = responses.filter((r) => r.status() === 429);

    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const res of refused) {
      expect(res.headers()["retry-after"]).toMatch(/^\d+$/);
      expect(res.headers()["x-ratelimit-remaining"]).toBe("0");
      const body = (await res.json()) as { error: string; retryAfter: number };
      expect(body.error).toMatch(/rate limit/i);
      expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    }

    // Health is never limited and is not starved by the burst.
    const h = await health;
    expect(h.status).toBe(200);
    expect(h.headers["x-ratelimit-limit"]).toBeUndefined();
    test.info().annotations.push({ type: "health-during-burst", description: `${h.ms} ms` });

    // Another session has its own budget.
    const other = await signIn(browser, "burst-other");
    const me = await other.page.request.get("/api/me");
    expect(me.status()).toBe(200);
  });
});
