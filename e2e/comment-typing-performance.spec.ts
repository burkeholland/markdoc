import type { Page } from "@playwright/test";
import { gzipSync } from "node:zlib";
import { cpus, totalmem } from "node:os";
import { expect, test } from "./fixtures";
import { codeText, createDocument, openDocument, signIn } from "./helpers";
import {
  TYPING_PERFORMANCE_DOCUMENT,
  TYPING_PERFORMANCE_PARAGRAPHS,
  TYPING_PERFORMANCE_TEXT,
  TYPING_PERFORMANCE_WARMUP,
} from "./fixtures/typing-performance";
import type { CollabSession } from "../src/editor/collab/session";
import type { EditorView } from "prosemirror-view";

interface Sample {
  input: number;
  mark: number;
  transaction: number;
  source: number;
  frameProxy: number;
}

interface Metric {
  calls: number;
  ms: number;
}

interface TraceEvent {
  name: string;
  ts: number;
  dur?: number;
  ph: string;
}

function isTraceEvent(value: unknown): value is TraceEvent {
  return typeof value === "object" && value !== null &&
    "name" in value && typeof value.name === "string" &&
    "ts" in value && typeof value.ts === "number" &&
    "ph" in value && typeof value.ph === "string" &&
    (!("dur" in value) || typeof value.dur === "number");
}

interface Harness {
  active: Sample | null;
  samples: Sample[];
  counts: Record<string, Metric>;
  longTasks: { start: number; duration: number }[];
}

declare global {
  interface Window {
    __commentTyping: Harness;
    __commentRenderCounts: Record<string, number>;
  }
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.ceil(sorted.length / 2) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: Math.max(...sorted),
  };
}

async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as typeof window & {
      __markdocSession: CollabSession;
      __markdocRichView: EditorView;
    };
    if (!w.__markdocSession) {
      // Production deliberately has no debug globals. Recover only this synthetic
      // fixture's mounted instances through React/ProseMirror's DOM ownership.
      const host = document.querySelector('[data-testid="rich-pane"]')!;
      const fiberKey = Object.keys(host).find((key) => key.startsWith("__reactFiber"));
      interface Fiber {
        memoizedProps?: { session?: CollabSession };
        return?: Fiber;
      }
      let fiber: Fiber | undefined = fiberKey ? Reflect.get(host, fiberKey) : undefined;
      while (fiber && !fiber.memoizedProps?.session) fiber = fiber.return;
      if (!fiber?.memoizedProps?.session) throw new Error("Synthetic editor session is not mounted");
      w.__markdocSession = fiber.memoizedProps.session;
      const richView = Reflect.get(w.__markdocSession.binding, "view");
      if (!richView) throw new Error("Synthetic rich view is not mounted");
      w.__markdocRichView = richView;
    }
    const session = w.__markdocSession;
    const view = w.__markdocRichView;
    const harness: Harness = {
      active: null,
      samples: [],
      counts: {},
      longTasks: [],
    };
    window.__commentTyping = harness;
    const count = (object: object, key: string, label: string) => {
      const original: unknown = Reflect.get(object, key);
      if (typeof original !== "function") throw new Error(`Missing method ${label}`);
      Object.defineProperty(object, key, {
        configurable: true,
        value: function (this: object, ...args: unknown[]) {
          const start = performance.now();
          try {
            return Reflect.apply(original, this, args);
          } finally {
            const metric = (harness.counts[label] ??= { calls: 0, ms: 0 });
            metric.calls++;
            metric.ms += performance.now() - start;
          }
        },
      });
    };
    count(session.comments, "list", "comments.list");
    count(session.comments, "get", "comments.get");
    count(session.comments, "read", "comments.read");
    count(session.suggestions, "list", "suggestions.list");
    count(session.binding, "getSourceMap", "sourceMap");
    count(session.binding, "parse", "binding.parse");
    count(session.binding, "buildDoc", "binding.buildDoc");
    count(session.binding, "authorizeLocalChange", "binding.authorize");
    count(session.ytext, "toString", "source.materialize");
    const prototype = Object.getPrototypeOf(view.state.doc);
    const content = Object.getOwnPropertyDescriptor(prototype, "textContent")!;
    Object.defineProperty(prototype, "textContent", {
      ...content,
      get() {
        const start = performance.now();
        const result = content.get!.call(this);
        if (this.type.name === "doc") {
          const metric = (harness.counts["document.textContent"] ??= { calls: 0, ms: 0 });
          metric.calls++;
          metric.ms += performance.now() - start;
        }
        return result;
      },
    });
    const sourceMap = session.binding.getSourceMap.bind(session.binding);
    session.binding.getSourceMap = () => {
      const before: unknown = Reflect.get(session.binding, "mapCache");
      const result = sourceMap();
      if (Reflect.get(session.binding, "mapCache") !== before) {
        const metric = (harness.counts["sourceMap.rebuild"] ??= { calls: 0, ms: 0 });
        metric.calls++;
      }
      return result;
    };
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (transaction) => {
      if (transaction.getMeta("markdoc/refresh")) {
        const metric = (harness.counts["decorations.refresh"] ??= { calls: 0, ms: 0 });
        metric.calls++;
      }
      dispatch(transaction);
      if (harness.active?.input && transaction.docChanged) {
        harness.active.transaction = performance.now();
      }
    };
    const local = session.binding.handleLocalTransaction.bind(session.binding);
    session.binding.handleLocalTransaction = (...args) => {
      const result = local(...args);
      if (harness.active?.input) harness.active.source = performance.now();
      return result;
    };
    session.subscribe(() => {
      const metric = (harness.counts["session.notify"] ??= { calls: 0, ms: 0 });
      metric.calls++;
    });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        harness.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask" });
    document.addEventListener("beforeinput", (event) => {
      const sample = harness.active;
      if (!sample || event.inputType !== "insertText") return;
      sample.input = performance.now();
      sample.mark = performance.mark(`comment-key-${harness.samples.length}`).startTime;
      requestAnimationFrame(() => setTimeout(() => {
        sample.frameProxy = performance.now();
        harness.samples.push(sample);
        if (harness.active === sample) harness.active = null;
      }, 0));
    }, true);
  });
}

async function typeCharacter(page: Page, character: string) {
  await page.evaluate(() => {
    window.__commentTyping.active = { input: 0, mark: 0, transaction: 0, source: 0, frameProxy: 0 };
  });
  await page.keyboard.type(character);
  await page.waitForFunction(() => window.__commentTyping.active === null);
}

const COMMENT_COUNTS = [0, 20, 200] as const;
// Playwright snapshots walk the entire editor DOM around every key.
test.use({ trace: "off" });
test.skip(process.env.E2E_COMMENT_TYPING_PROFILE !== "1", "Opt-in profiling requires a scheduled local browser and server");
const POSITIONS = [
  { name: "top", index: 0 },
  { name: "middle", index: 500 },
  { name: "end", index: 999 },
] as const;

function selectCases(raw: string | undefined) {
  const cases = COMMENT_COUNTS.flatMap((count) =>
    ["closed", "open"].flatMap((sidebar) => POSITIONS.map((position) => `${count}/${sidebar}/${position.name}`)),
  );
  if (raw === undefined) return new Set(cases);
  const requested = raw.split(",").map((value) => value.trim());
  if (requested.some((value) => value.length === 0)) {
    throw new Error("E2E_COMMENT_TYPING_CASES must contain nonempty comma-separated count/sidebar/position IDs");
  }
  const selected = new Set(requested);
  if (selected.size !== requested.length) {
    throw new Error("E2E_COMMENT_TYPING_CASES must not contain duplicate case IDs");
  }
  if (requested.some((value) => !cases.includes(value))) {
    throw new Error("E2E_COMMENT_TYPING_CASES contains an unknown case ID (counts: 0/20/200; sidebar: closed/open; position: top/middle/end)");
  }
  return new Set(cases.filter((value) => selected.has(value)));
}

// Validate during collection, before fixtures can start a browser or create documents.
const SELECTED_CASES = selectCases(process.env.E2E_COMMENT_TYPING_CASES);

test("profiles comment-heavy typing with immediate text, caret, anchors, and undo", async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
  const configured = new URL(String(testInfo.project.use.baseURL));
  expect(["localhost", "127.0.0.1"]).toContain(configured.hostname);
  expect(configured.port).toBe(process.env.E2E_PORT ?? "3412");
  const user = await signIn(browser, `comment-perf-${Date.now().toString(36)}`);
  const { page } = user;
  await page.addInitScript(() => {
    window.__commentRenderCounts = {};
    interface Fiber {
      flags: number;
      memoizedProps?: Record<string, unknown>;
      child?: Fiber;
      sibling?: Fiber;
    }
    const visit = (fiber?: Fiber) => {
      if (!fiber) return;
      const props = fiber.memoizedProps;
      if (props && (fiber.flags & 1) !== 0) {
        const name = "initialDoc" in props ? "editorShell"
          : "onPendingDone" in props && "session" in props ? "commentsPanel"
          : "thread" in props && "session" in props ? "threadCard" : null;
        if (name) window.__commentRenderCounts[name] = (window.__commentRenderCounts[name] ?? 0) + 1;
      }
      visit(fiber.child);
      visit(fiber.sibling);
    };
    Reflect.set(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => visit(root.current),
      onCommitFiberUnmount: () => {},
    });
  });
  // All requests, including avatars, stay inside this disposable local runtime.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === configured.origin ? route.continue() : route.abort();
  });
  const results: object[] = [];
  try {
    for (const commentCount of COMMENT_COUNTS) {
      if (![...SELECTED_CASES].some((id) => id.startsWith(`${commentCount}/`))) continue;
      const docId = await createDocument(page, TYPING_PERFORMANCE_DOCUMENT, "Synthetic comment typing benchmark");
      for (let index = 0; index < commentCount; index++) {
        const paragraph = Math.floor(index * TYPING_PERFORMANCE_PARAGRAPHS / commentCount);
        const response = await page.request.post(`/api/documents/${docId}/comments`, {
          data: {
            action: "add",
            quote: `Benchmark paragraph ${paragraph.toString().padStart(4, "0")}`,
            body: `Synthetic comment ${index}`,
          },
        });
        expect(response.ok()).toBe(true);
      }
      await openDocument(page, docId);
      await instrument(page);
      expect((TYPING_PERFORMANCE_DOCUMENT.match(/\S+/g) ?? []).length).toBeGreaterThanOrEqual(12_000);
      expect(await page.locator(".md-rich p").count()).toBeGreaterThanOrEqual(1_000);
      for (const sidebar of [false, true]) {
        const positions = POSITIONS.filter((position) =>
          SELECTED_CASES.has(`${commentCount}/${sidebar ? "open" : "closed"}/${position.name}`),
        );
        if (positions.length === 0) continue;
        if (sidebar) await page.getByTestId("comments-toggle").click();
        for (const position of positions) {
          const startedAtUtc = new Date().toISOString();
          const paragraph = page.locator(".md-rich p").filter({
            hasText: `Benchmark paragraph ${position.index.toString().padStart(4, "0")}`,
          }).first();
          await paragraph.scrollIntoViewIfNeeded();
          await paragraph.evaluate((element) => {
            const selection = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
            (element.closest("[contenteditable]") as HTMLElement).focus();
            document.dispatchEvent(new Event("selectionchange"));
          });
          await page.waitForTimeout(600);
          for (const character of TYPING_PERFORMANCE_WARMUP) await typeCharacter(page, character);
          for (let index = 0; index < TYPING_PERFORMANCE_WARMUP.length; index++) await page.keyboard.press("Backspace");
          await expect.poll(() => codeText(page)).toBe(TYPING_PERFORMANCE_DOCUMENT);
          await page.waitForTimeout(600);
          const before = await page.evaluate(() => {
            const w = window as typeof window & { __markdocSession: CollabSession; __markdocRichView: EditorView };
            const { __markdocSession: session, __markdocRichView: view } = w;
            session.undoManager.clear();
            const comments = session.comments.list().map(({ id, range, quote }) => ({ id, range, quote }));
            const offset = session.binding.getSourceMap().pmToSrc(view.state.selection.head);
            window.__commentTyping.counts = {};
            window.__commentTyping.samples = [];
            window.__commentTyping.longTasks = [];
            window.__commentRenderCounts = {};
            return { head: view.state.selection.head, offset, comments };
          });
          const cdp = await page.context().newCDPSession(page);
          const trace: TraceEvent[] = [];
          cdp.on("Tracing.dataCollected", (event) => {
            const values: unknown[] = event.value;
            trace.push(...values.filter(isTraceEvent));
          });
          await cdp.send("Tracing.start", {
            categories: "devtools.timeline,blink.user_timing",
            options: "record-as-much-as-possible",
          });
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.start");
          for (const character of TYPING_PERFORMANCE_TEXT) await typeCharacter(page, character);
          const { profile } = await cdp.send("Profiler.stop");
          const traceComplete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
          await cdp.send("Tracing.end");
          await traceComplete;
          const after = await page.evaluate(() => {
            const w = window as typeof window & { __markdocSession: CollabSession; __markdocRichView: EditorView };
            const { __markdocSession: session, __markdocRichView: view } = w;
            const metrics = structuredClone(window.__commentTyping);
            return {
              metrics, head: view.state.selection.head, source: session.ytext.toString(),
              timeOrigin: performance.timeOrigin,
              renders: { ...window.__commentRenderCounts },
              comments: session.comments.list().map(({ id, range, quote }) => ({ id, range, quote })),
              undoDepth: session.undoManager.undoStack.length,
            };
          });
          const expected = TYPING_PERFORMANCE_DOCUMENT.slice(0, before.offset) +
            TYPING_PERFORMANCE_TEXT + TYPING_PERFORMANCE_DOCUMENT.slice(before.offset);
          expect(after.source).toBe(expected);
          expect(after.head).toBe(before.head + 100);
          expect(after.comments).toHaveLength(commentCount);
          for (const thread of after.comments) {
            const original = before.comments.find((entry) => entry.id === thread.id)!;
            expect(thread.quote).toBe(original.quote);
            expect(thread.range).not.toBeNull();
            expect(expected.slice(thread.range!.from, thread.range!.to)).toBe(thread.quote);
          }
          expect(after.metrics.samples).toHaveLength(100);
          expect(after.undoDepth).toBe(1);
          await page.keyboard.press("ControlOrMeta+z");
          await expect.poll(() => codeText(page)).toBe(TYPING_PERFORMANCE_DOCUMENT);
          const endedAtUtc = new Date().toISOString();
          const stackSamples = new Map<number, number>();
          for (const id of profile.samples ?? []) stackSamples.set(id, (stackSamples.get(id) ?? 0) + 1);
          const hotFunctions = profile.nodes.map((node) => ({
            function: node.callFrame.functionName, url: node.callFrame.url,
            samples: stackSamples.get(node.id) ?? 0,
          })).sort((a, b) => b.samples - a.samples).slice(0, 20);
          const { samples, counts, longTasks } = after.metrics;
          const paints = trace.filter((event) => event.name === "Paint" && event.ph === "X");
          const marks = trace.filter((event) => /^comment-key-\d+$/.test(event.name)).sort((a, b) => a.ts - b.ts);
          expect(marks.map((mark) => mark.name)).toEqual(samples.map((_, index) => `comment-key-${index}`));
          const inputTimings = marks.flatMap((mark, index) => {
            const paint = paints.find((event) => event.ts >= mark.ts && event.ts < (marks[index + 1]?.ts ?? Infinity));
            if (!paint) return [];
            const sample = samples[index];
            return [{
              index, input: sample.input, mark: sample.mark, traceMarkUs: mark.ts,
              paintStart: sample.mark + (paint.ts - mark.ts) / 1000,
              paintEnd: sample.mark + (paint.ts + (paint.dur ?? 0) - mark.ts) / 1000,
              paintDuration: (paint.ts + (paint.dur ?? 0) - mark.ts) / 1000,
            }];
          });
          expect(inputTimings).toHaveLength(100);
          const paintDurations = inputTimings.map((timing) => timing.paintDuration);
          const row = {
            phase: process.env.E2E_PERF_BASELINE === "1" ? "baseline" : "after",
            commentCount, sidebar, position: position.name,
            transaction: summary(samples.map((sample) => sample.transaction - sample.input)),
            source: summary(samples.map((sample) => sample.source - sample.input)),
            mainThreadPaint: paintDurations.length ? summary(paintDurations) : null,
            measuredPaints: paintDurations.length,
            frameProxy: summary(samples.map((sample) => sample.frameProxy - sample.input)),
            counts, renders: after.renders, longTasks, hotFunctions,
            timing: {
              startedAtUtc, endedAtUtc, timeOrigin: after.timeOrigin,
              inputs: inputTimings,
            },
          };
          results.push(row);
          console.log(`[comment-typing] ${JSON.stringify(row)}`);
          if (process.env.E2E_PERF_AGGREGATES_ONLY !== "1") {
            await testInfo.attach(`${commentCount}-${sidebar}-${position.name}.cpuprofile`, {
              body: Buffer.from(JSON.stringify(profile)), contentType: "application/json",
            });
            await testInfo.attach(`${commentCount}-${sidebar}-${position.name}-timeline.json.gz`, {
              body: gzipSync(JSON.stringify({ traceEvents: trace })), contentType: "application/gzip",
            });
          }
          await cdp.detach();
        }
      }
    }
    await testInfo.attach("comment-typing-results.json", {
      body: Buffer.from(JSON.stringify({
        browser: browser.version(), mode: process.env.PROD_BASE_URL ? "production" : "development",
        machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem() / 2 ** 30 },
        fixture: {
          bytes: Buffer.byteLength(TYPING_PERFORMANCE_DOCUMENT),
          words: TYPING_PERFORMANCE_DOCUMENT.match(/\S+/g)!.length,
          paragraphs: TYPING_PERFORMANCE_PARAGRAPHS, warmup: 10, characters: 100,
        },
        selectedCases: [...SELECTED_CASES],
        measurement: "beforeinput to dispatch/local Yjs completion; rAF+timer is a proxy; trace measures first main-thread Paint completion, not physical display presentation or remote acknowledgement",
        timing: "Case UTC bounds include warmup and undo. Input, mark, Paint bounds and long tasks are milliseconds relative to performance.timeOrigin (Unix epoch ms); traceMarkUs is the matching CDP timestamp. Overlap with [input, paintEnd] locates a long task in an input interval, not its causal stack.",
        results,
      }, null, 2)),
      contentType: "application/json",
    });
  } finally {
    await user.context.close();
  }
});
