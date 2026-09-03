import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { clickEdgeOf, codeText, createDocument, focusRichEnd, openDocument, signIn, type User } from "./helpers";
import {
  TYPING_PERFORMANCE_COMMENT_QUOTES,
  TYPING_PERFORMANCE_DOCUMENT,
  TYPING_PERFORMANCE_PARAGRAPHS,
  TYPING_PERFORMANCE_TEXT,
  TYPING_PERFORMANCE_WARMUP,
} from "./fixtures/typing-performance";

interface InputSample {
  input: number;
  transaction: number;
  source: number;
  paint: number;
}

interface Counters {
  diffStart: number;
  diffEnd: number;
  bindingDiffStart: number;
  bindingDiffEnd: number;
  sourceMap: number;
  sourceMapRebuild: number;
  parse: number;
  remoteRebuild: number;
  refresh: number;
  sessionNotify: number;
  verify: number;
}

interface PositionResult {
  samples: InputSample[];
  counters: Counters;
  longTasks: { start: number; duration: number }[];
  before: EditorSnapshot;
  after: EditorSnapshot;
  afterOneUndo?: EditorSnapshot;
}

interface EditorSnapshot {
  sourceLength: number;
  selection: { anchor: number; head: number };
  undoDepth: number;
  redoDepth: number;
}

const BASELINE_END_P95_PAINT_MS = 64.8;
const TARGET_END_P95_PAINT_MS = BASELINE_END_P95_PAINT_MS / 2;

const percentile = (values: number[], quantile: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
};

const timingSummary = (samples: InputSample[], key: keyof Omit<InputSample, "input">) => {
  const values = samples.map((sample) => sample[key] - sample.input);
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
};

async function installInstrumentation(page: Page) {
  await page.evaluate(() => {
    interface ActiveSample {
      input: number;
      transaction: number;
      source: number;
      paint: number;
    }
    interface Harness {
      active: ActiveSample | null;
      samples: ActiveSample[];
      counters: Counters;
      longTasks: { start: number; duration: number }[];
      arm(): void;
      snapshot(): Counters;
    }
    interface Binding {
      mapCache: unknown;
      verifyStats: { runs: number };
      handleLocalTransaction(...args: unknown[]): unknown;
      getSourceMap(...args: unknown[]): unknown;
      parse(...args: unknown[]): unknown;
      syncFromText(...args: unknown[]): unknown;
    }
    interface Session {
      binding: Binding;
      subscribe(listener: () => void): () => void;
      ytext: { observe(listener: () => void): void };
    }
    interface View {
      dispatch(transaction: { getMeta(key: string): unknown }): void;
      state: { doc: { content: object } };
    }
    type WindowWithEditor = Window & {
      __markdocSession: Session;
      __markdocRichView: View;
      __typingPerformance?: Harness;
    };

    const w = window as unknown as WindowWithEditor;
    if (w.__typingPerformance) return;
    const binding = w.__markdocSession.binding;
    const view = w.__markdocRichView;
    const counters: Counters = {
      diffStart: 0,
      diffEnd: 0,
      bindingDiffStart: 0,
      bindingDiffEnd: 0,
      sourceMap: 0,
      sourceMapRebuild: 0,
      parse: 0,
      remoteRebuild: 0,
      refresh: 0,
      sessionNotify: 0,
      verify: binding.verifyStats.runs,
    };
    const harness: Harness = {
      active: null,
      samples: [],
      counters,
      longTasks: [],
      arm() {
        this.active = { input: 0, transaction: 0, source: 0, paint: 0 };
      },
      snapshot() {
        return { ...this.counters, verify: binding.verifyStats.runs };
      },
    };
    w.__typingPerformance = harness;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) harness.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });

    const fragment = Object.getPrototypeOf(view.state.doc.content) as {
      findDiffStart(...args: unknown[]): unknown;
      findDiffEnd(...args: unknown[]): unknown;
    };
    const findDiffStart = fragment.findDiffStart;
    const findDiffEnd = fragment.findDiffEnd;
    let bindingActive = false;
    fragment.findDiffStart = function (...args: unknown[]) {
      counters.diffStart++;
      if (bindingActive) counters.bindingDiffStart++;
      return findDiffStart.apply(this, args);
    };
    fragment.findDiffEnd = function (...args: unknown[]) {
      counters.diffEnd++;
      if (bindingActive) counters.bindingDiffEnd++;
      return findDiffEnd.apply(this, args);
    };

    const handleLocalTransaction = binding.handleLocalTransaction;
    binding.handleLocalTransaction = function (...args: unknown[]) {
      bindingActive = true;
      try {
        return handleLocalTransaction.apply(this, args);
      } finally {
        bindingActive = false;
        if (harness.active?.input) harness.active.transaction = performance.now();
      }
    };
    const getSourceMap = binding.getSourceMap;
    binding.getSourceMap = function (...args: unknown[]) {
      counters.sourceMap++;
      const previous = this.mapCache;
      const result = getSourceMap.apply(this, args);
      if (this.mapCache !== previous) counters.sourceMapRebuild++;
      return result;
    };
    const parse = binding.parse;
    binding.parse = function (...args: unknown[]) {
      counters.parse++;
      return parse.apply(this, args);
    };
    const syncFromText = binding.syncFromText;
    binding.syncFromText = function (...args: unknown[]) {
      counters.remoteRebuild++;
      return syncFromText.apply(this, args);
    };
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (transaction) => {
      if (transaction.getMeta("markdoc/refresh")) counters.refresh++;
      dispatch(transaction);
    };
    w.__markdocSession.subscribe(() => counters.sessionNotify++);
    w.__markdocSession.ytext.observe(() => {
      if (harness.active?.input) harness.active.source = performance.now();
    });
    document.addEventListener(
      "beforeinput",
      (event) => {
        const active = harness.active;
        if (!active || event.inputType !== "insertText") return;
        active.input = performance.now();
        requestAnimationFrame(() =>
          setTimeout(() => {
            active.paint = performance.now();
            harness.samples.push(active);
            if (harness.active === active) harness.active = null;
          }, 0),
        );
      },
      true,
    );
  });
}

const counters = (page: Page) =>
  page.evaluate(() => {
    const harness = (window as unknown as { __typingPerformance: { snapshot(): Counters } }).__typingPerformance;
    return harness.snapshot();
  });

const editorSnapshot = (page: Page) =>
  page.evaluate(() => {
    const windowWithEditor = window as unknown as {
      __markdocSession: {
        ytext: { length: number };
        undoManager: { undoStack: unknown[]; redoStack: unknown[] };
      };
      __markdocRichView: { state: { selection: { anchor: number; head: number } } };
    };
    return {
      sourceLength: windowWithEditor.__markdocSession.ytext.length,
      selection: {
        anchor: windowWithEditor.__markdocRichView.state.selection.anchor,
        head: windowWithEditor.__markdocRichView.state.selection.head,
      },
      undoDepth: windowWithEditor.__markdocSession.undoManager.undoStack.length,
      redoDepth: windowWithEditor.__markdocSession.undoManager.redoStack.length,
    };
  });

const subtractCounters = (after: Counters, before: Counters): Counters => ({
  diffStart: after.diffStart - before.diffStart,
  diffEnd: after.diffEnd - before.diffEnd,
  bindingDiffStart: after.bindingDiffStart - before.bindingDiffStart,
  bindingDiffEnd: after.bindingDiffEnd - before.bindingDiffEnd,
  sourceMap: after.sourceMap - before.sourceMap,
  sourceMapRebuild: after.sourceMapRebuild - before.sourceMapRebuild,
  parse: after.parse - before.parse,
  remoteRebuild: after.remoteRebuild - before.remoteRebuild,
  refresh: after.refresh - before.refresh,
  sessionNotify: after.sessionNotify - before.sessionNotify,
  verify: after.verify - before.verify,
});

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function typeOne(page: Page, character: string): Promise<InputSample> {
  const index = await page.evaluate(() => {
    const harness = (window as unknown as { __typingPerformance: { arm(): void; samples: InputSample[] } }).__typingPerformance;
    harness.arm();
    return harness.samples.length;
  });
  await page.keyboard.type(character);
  await page.waitForFunction(
    (sampleIndex) => {
      const sample = (window as unknown as { __typingPerformance: { samples: InputSample[] } }).__typingPerformance.samples[sampleIndex];
      return Boolean(sample?.transaction && sample.source && sample.paint);
    },
    index,
  );
  return page.evaluate(
    (sampleIndex) => (window as unknown as { __typingPerformance: { samples: InputSample[] } }).__typingPerformance.samples[sampleIndex],
    index,
  );
}

async function warmUp(page: Page, original: string) {
  for (const character of TYPING_PERFORMANCE_WARMUP) await typeOne(page, character);
  for (let index = 0; index < TYPING_PERFORMANCE_WARMUP.length; index++) await page.keyboard.press("Backspace");
  await expect.poll(() => codeText(page)).toBe(original);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as unknown as { __markdocSession: { undoManager: { clear(): void } } }).__markdocSession.undoManager.clear();
  });
  await settle(page);
}

async function measurePosition(page: Page, original: string, expected: string): Promise<PositionResult> {
  await warmUp(page, original);
  const stateBefore = await editorSnapshot(page);
  const phaseStart = await page.evaluate(() => performance.now());
  const longTaskIndex = await page.evaluate(
    () => (window as unknown as { __typingPerformance: { longTasks: { start: number; duration: number }[] } }).__typingPerformance.longTasks.length,
  );
  const countersBefore = await counters(page);
  const samples: InputSample[] = [];
  for (const character of TYPING_PERFORMANCE_TEXT) samples.push(await typeOne(page, character));
  const countersAfterInput = await counters(page);
  await expect.poll(() => codeText(page)).toBe(expected);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  await settle(page);
  const stateAfter = await editorSnapshot(page);
  const phaseEnd = samples.at(-1)!.paint;
  const longTasks = (
    await page.evaluate(
      (index) => (window as unknown as { __typingPerformance: { longTasks: { start: number; duration: number }[] } }).__typingPerformance.longTasks.slice(index),
      longTaskIndex,
    )
  ).filter((task) => task.start <= phaseEnd && task.start + task.duration >= phaseStart);
  return {
    samples,
    counters: subtractCounters(countersAfterInput, countersBefore),
    longTasks,
    before: stateBefore,
    after: stateAfter,
  };
}

async function undoMeasuredBurst(page: Page, result: PositionResult, original: string, inserted: string) {
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => codeText(page)).not.toBe(inserted);
  result.afterOneUndo = await editorSnapshot(page);
  expect(result.afterOneUndo.sourceLength).toBeLessThan(inserted.length);
  expect(result.afterOneUndo.sourceLength).toBeGreaterThanOrEqual(original.length);
  for (let index = 0; index < result.after.undoDepth && (await codeText(page)) !== original; index++) {
    await page.keyboard.press("ControlOrMeta+z");
  }
  await expect.poll(() => codeText(page)).toBe(original);
}

test.describe("long-document rich typing performance", () => {
  test.describe.configure({ timeout: 240_000 });
  let user: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, `typing-performance-${Date.now().toString(36)}`);
    docId = await createDocument(user.page, TYPING_PERFORMANCE_DOCUMENT, "Long-document typing performance");
    for (const [index, quote] of TYPING_PERFORMANCE_COMMENT_QUOTES.entries()) {
      const response = await user.page.request.post(`/api/documents/${docId}/comments`, {
        data: { action: "add", quote, body: `Deterministic performance comment ${index + 1}` },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await openDocument(user.page, docId);
    await installInstrumentation(user.page);
  });

  test.afterAll(async () => {
    await user.context.close();
  });

  test("keeps end-of-document input incremental and preserves text, caret, collaboration, comments, and undo", async () => {
    const { page } = user;
    expect((TYPING_PERFORMANCE_DOCUMENT.match(/\S+/g) ?? []).length).toBeGreaterThanOrEqual(12_000);
    expect(await page.locator(".md-rich p").count()).toBeGreaterThanOrEqual(TYPING_PERFORMANCE_PARAGRAPHS);
    expect(
      await page.evaluate(() => (window as unknown as { __markdocSession: { comments: { list(): unknown[] } } }).__markdocSession.comments.list().length),
    ).toBeGreaterThanOrEqual(20);

    await focusRichEnd(page);
    await settle(page);
    const end = await measurePosition(page, TYPING_PERFORMANCE_DOCUMENT, TYPING_PERFORMANCE_DOCUMENT + TYPING_PERFORMANCE_TEXT);
    expect(await codeText(page)).toBe(TYPING_PERFORMANCE_DOCUMENT + TYPING_PERFORMANCE_TEXT);
    const endCaret = await page.evaluate(() => {
      const view = (window as unknown as { __markdocRichView: { state: { selection: { head: number } } } }).__markdocRichView;
      return view.state.selection.head;
    });
    await undoMeasuredBurst(page, end, TYPING_PERFORMANCE_DOCUMENT, TYPING_PERFORMANCE_DOCUMENT + TYPING_PERFORMANCE_TEXT);
    expect(end.after.selection).toEqual({
      anchor: end.before.selection.anchor + TYPING_PERFORMANCE_TEXT.length,
      head: end.before.selection.head + TYPING_PERFORMANCE_TEXT.length,
    });

    await page.locator(".md-rich p").first().scrollIntoViewIfNeeded();
    await clickEdgeOf(page, "p", "end");
    await settle(page);
    const firstParagraphEnd = TYPING_PERFORMANCE_DOCUMENT.indexOf("\n\n", TYPING_PERFORMANCE_DOCUMENT.indexOf("\n\n") + 2);
    const firstExpected =
      TYPING_PERFORMANCE_DOCUMENT.slice(0, firstParagraphEnd) + TYPING_PERFORMANCE_TEXT + TYPING_PERFORMANCE_DOCUMENT.slice(firstParagraphEnd);
    const first = await measurePosition(page, TYPING_PERFORMANCE_DOCUMENT, firstExpected);
    expect(await codeText(page)).toBe(firstExpected);
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/documents/${docId}/content`);
        return ((await response.json()) as { content: string }).content;
      })
      .toBe(firstExpected);
    await undoMeasuredBurst(page, first, TYPING_PERFORMANCE_DOCUMENT, firstExpected);
    expect(first.after.selection).toEqual({
      anchor: first.before.selection.anchor + TYPING_PERFORMANCE_TEXT.length,
      head: first.before.selection.head + TYPING_PERFORMANCE_TEXT.length,
    });
    expect(
      await page.evaluate(() => (window as unknown as { __markdocSession: { comments: { list(): unknown[] } } }).__markdocSession.comments.list().length),
    ).toBe(20);

    console.log(
      `[typing-performance] ${JSON.stringify({
        fixture: {
          words: (TYPING_PERFORMANCE_DOCUMENT.match(/\S+/g) ?? []).length,
          paragraphs: TYPING_PERFORMANCE_PARAGRAPHS,
          comments: TYPING_PERFORMANCE_COMMENT_QUOTES.length,
          warmupCharacters: TYPING_PERFORMANCE_WARMUP.length,
          measuredCharacters: TYPING_PERFORMANCE_TEXT.length,
        },
        browser: "Playwright Desktop Chrome / Chromium",
        mode: process.env.PROD_BASE_URL ? "production" : "development",
        first: {
          transaction: timingSummary(first.samples, "transaction"),
          source: timingSummary(first.samples, "source"),
          paint: timingSummary(first.samples, "paint"),
          counters: first.counters,
          longTasks: first.longTasks,
          state: { before: first.before, after: first.after, afterOneUndo: first.afterOneUndo },
        },
        end: {
          transaction: timingSummary(end.samples, "transaction"),
          source: timingSummary(end.samples, "source"),
          paint: timingSummary(end.samples, "paint"),
          counters: end.counters,
          longTasks: end.longTasks,
          state: { before: end.before, after: end.after, afterOneUndo: end.afterOneUndo },
        },
      })}`,
    );

    expect(end.samples).toHaveLength(100);
    expect(first.samples).toHaveLength(100);
    expect(end.samples.every((sample) => sample.transaction >= sample.input && sample.source >= sample.input && sample.paint >= sample.input)).toBe(true);
    if (process.env.E2E_PERF_BASELINE !== "1") {
      expect(end.counters.bindingDiffStart + end.counters.bindingDiffEnd).toBe(0);
      expect(end.counters.parse).toBe(0);
      expect(end.counters.remoteRebuild).toBe(0);
      expect(end.counters.verify).toBe(0);
      expect(end.counters.sourceMapRebuild).toBe(0);
      expect(end.counters.refresh).toBe(0);
      expect(end.counters.sessionNotify).toBeLessThanOrEqual(2);
      expect(end.longTasks.filter((task) => task.duration > 100)).toHaveLength(0);
      expect(timingSummary(end.samples, "paint").p95).toBeLessThanOrEqual(TARGET_END_P95_PAINT_MS);
    }
    expect(endCaret).toBeGreaterThan(TYPING_PERFORMANCE_PARAGRAPHS);
  });
});
