import { test as base, expect } from "@playwright/test";

export { expect };

/**
 * Playwright's `test` with one automatic, test-scoped fixture: every browser context a test opens and
 * does not close itself is closed when the test ends (task #1491).
 *
 * The `browser` fixture is worker-scoped, so with one worker a context that `signIn(browser, …)` opened
 * in test #1 and nobody closed was still alive at test #347: its page kept its collab WebSocket, its
 * presence heartbeat and, on a GitHub-linked document, the `/api/documents/<id>/sync` poll every 2 s.
 * The first full nightly run paid 41 % of its request lines for those orphans.
 *
 * How it works: the fixture snapshots `browser.contexts()` when the test starts (before any `beforeEach`
 * hook) and, on teardown (after every `afterEach` hook), closes each context that is open then and was
 * not in the snapshot. Depending on `context` makes Playwright create the test's own default context
 * before the snapshot, so ours never closes it — Playwright's own teardown does. Contexts opened in
 * `test.beforeAll` also predate the snapshot and are left alone: they live until `afterAll` closes them
 * (or the worker ends), exactly as before.
 *
 * `keepContexts` is the opt-out for a file whose serial tests deliberately hand a context from one test
 * to the next: `test.use({ keepContexts: true })` at the top of that file, with a one-line comment
 * saying which test hands what to which. Prefer moving the `signIn` into `test.beforeAll`.
 */
export const test = base.extend<{ keepContexts: boolean; _closeOpenedContexts: void }>({
  keepContexts: [false, { option: true }],
  _closeOpenedContexts: [
    async ({ browser, context, keepContexts }, use, testInfo) => {
      // `context` is in `browser.contexts()` already; naming it keeps the dependency (and the ordering) explicit.
      const before = new Set([context, ...browser.contexts()]);
      await use();
      if (keepContexts) return;
      const opened = browser.contexts().filter((c) => !before.has(c));
      if (opened.length === 0) return;
      // Visible in the JSON/HTML report per test, silent on the list reporter: how many contexts leaked.
      testInfo.annotations.push({ type: "closed-contexts", description: String(opened.length) });
      await Promise.all(
        opened.map((c) => c.close({ reason: "e2e/fixtures.ts: the test that opened this context ended" }).catch(() => {})),
      );
    },
    { auto: true, title: "close the browser contexts this test opened" },
  ],
});
