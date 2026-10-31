// Large-document typing + scroll + reader measurement (#2401, #2417, #2418): ~3000 lines / ~42k words.
// BASE_URL=http://localhost:3000 npx tsx scripts/perf-large-doc.mts [--profile] [--trace]
import { gzipSync } from "node:zlib";
import { chromium, type Page } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const profile = process.argv.includes("--profile");
const words = "the quick brown fox jumps over the lazy dog while markdown editors render long documents".split(" ");
const line = (i: number) => Array.from({ length: 28 }, (_, w) => words[(i * 7 + w) % words.length]).join(" ");
const lines: string[] = [`# Large document ${Date.now().toString(36)}`, ""];
for (let i = 0; lines.length < 3000; i++) {
  if (i % 20 === 0) lines.push(`## Section ${i / 20}`, "");
  lines.push(i % 9 === 0 ? `- ${line(i)} **bold** and \`code\`` : `${line(i)} [link](https://example.com/${i}).`, "");
}
const content = lines.join("\n");

const pct = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.max(0, Math.ceil(v.length * q) - 1)];

// Keystroke→next frame p50/p90, and the renderer main thread's busy time per keystroke from a trace
// (`mainMsPerKey`): the frame latency cannot go below one frame, the busy time shows the work itself.
async function typingLatency(page: Page, n = 40): Promise<{ p50: number; p90: number; mainMsPerKey: number }> {
  const out: number[] = [];
  await browser.startTracing(page, { categories: ["devtools.timeline", "toplevel"] });
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => {
      const w = window as unknown as { __t: number[] };
      w.__t = [];
      document.addEventListener(
        "beforeinput",
        () => {
          const s = performance.now();
          requestAnimationFrame(() => setTimeout(() => w.__t.push(performance.now() - s), 0));
        },
        { capture: true, once: true },
      );
    });
    await page.keyboard.type("x");
    await page.waitForFunction(() => (window as unknown as { __t: number[] }).__t.length > 0);
    out.push(await page.evaluate(() => (window as unknown as { __t: number[] }).__t[0]));
    await page.waitForTimeout(30);
  }
  const events = (JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string; ph: string; dur?: number; tid: number; pid: number; args?: { name?: string } }[] }).traceEvents;
  const mains = new Set(events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const perThread = new Map<string, number>();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    if (e.name === "ThreadControllerImpl::RunTask" && e.ph === "X" && mains.has(key)) perThread.set(key, (perThread.get(key) ?? 0) + (e.dur ?? 0) / 1000);
  }
  const busy = Math.max(0, ...perThread.values());
  return { p50: Math.round(pct(out, 0.5)), p90: Math.round(pct(out, 0.9)), mainMsPerKey: Math.round((busy / n) * 10) / 10 };
}

async function cpuProfile<T>(page: Page, label: string, fn: () => Promise<T>): Promise<T> {
  if (!profile) return fn();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const result = await fn();
  const { profile: p } = await cdp.send("Profiler.stop");
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  const deltas = p.timeDeltas ?? [];
  for (let i = 0; i < p.samples!.length; i++) {
    const cf = byId.get(p.samples![i])!.callFrame;
    const key = `${cf.functionName || "(anon)"} @ ${cf.url.replace(/^.*\//, "").replace(/\?.*$/, "").slice(0, 50)}:${cf.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  }
  console.log(`--- profile: ${label}`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${String(Math.round(v)).padStart(6)} ms  ${k}`);
  return result;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(180_000);
await page.goto(`${base}/login`);
await page.getByTestId("dev-login").fill(`perf-large-${Date.now().toString(36)}`);
await page.getByTestId("dev-login-submit").click();
await page.waitForURL(`${base}/`);
const res = await page.request.post(`${base}/api/documents`, { data: { content } });
const id = ((await res.json()) as { document: { id: string } }).document.id;
await page.goto(`${base}/d/${id}`);
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 120000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const w = window as unknown as { __lt: number[] };
  w.__lt = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(e.duration))).observe({ type: "longtask" });
});

await page.locator(".md-rich h1").click();
await page.keyboard.press("End");
const rich = await cpuProfile(page, "rich typing", () => typingLatency(page));

await page.locator(".cm-content").click();
await page.keyboard.press("ControlOrMeta+End");
const source = await cpuProfile(page, "source typing", () => typingLatency(page));

await page.evaluate(() => ((window as unknown as { __lt: number[] }).__lt = []));
const box = (await page.locator(".md-rich").evaluateHandle((dom) => {
  for (let e = dom.parentElement; e; e = e.parentElement) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight) return e;
  return dom;
}).then((h) => h.asElement()!.boundingBox()))!;
await page.mouse.move(box.x + box.width / 2, box.y + 300);
const verifyRuns = () => page.evaluate(() => (window as unknown as { __markdocSession: { binding: { verifyStats: { runs: number } } } }).__markdocSession?.binding.verifyStats.runs ?? 0);
await page.evaluate(() => {
  const w = window as unknown as { __dbg: string[]; __markdocSession: { binding: { verifyParse: () => boolean } } };
  w.__dbg = [];
  if (!w.__markdocSession) return;
  const b = w.__markdocSession.binding;
  const orig = b.verifyParse.bind(b);
  b.verifyParse = () => (w.__dbg.push(`verify@${Math.round(performance.now())}`), orig());
  let n = 0;
  document.addEventListener("wheel", () => n++ % 10 === 0 && w.__dbg.push(`wheel@${Math.round(performance.now())}`), true);
});
const verifyBefore = await verifyRuns();
const trace = process.argv.includes("--trace");
if (trace) await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
await cpuProfile(page, "rich scroll", async () => {
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, i < 20 ? -2500 : 2500);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
});
if (trace) {
  const buf = await browser.stopTracing();
  const events = (JSON.parse(buf.toString()) as { traceEvents: { name: string; ph: string; dur?: number; ts: number; tid: number }[] }).traceEvents;
  const tasks = events.filter((e) => e.name === "RunTask" && (e.dur ?? 0) > 50_000).sort((a, b) => b.dur! - a.dur!);
  for (const t of tasks.slice(0, 3)) {
    const inner = new Map<string, number>();
    for (const e of events) {
      if (e.tid !== t.tid || e.ph !== "X" || e === t || e.ts < t.ts || e.ts > t.ts + t.dur!) continue;
      inner.set(e.name, (inner.get(e.name) ?? 0) + (e.dur ?? 0) / 1000);
    }
    console.log(`--- long task ${Math.round(t.dur! / 1000)}ms:`, [...inner].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${Math.round(v)}`).join(" "));
  }
}
console.log(await page.evaluate(() => (window as unknown as { __dbg: string[] }).__dbg.join(" ")));
const lt = await page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
const readerStart = performance.now();
const html = await page.request.get(`${base}/p/${id}`, { headers: { "accept-encoding": "identity" } });
const readerMs = Math.round(performance.now() - readerStart);
const readerBody = await html.body();
const repeats: number[] = [];
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  await (await page.request.get(`${base}/p/${id}`)).body();
  repeats.push(performance.now() - t);
}
console.log(
  JSON.stringify({
    words: (content.match(/\S+/g) ?? []).length,
    lines: content.split("\n").length,
    richTyping: rich,
    sourceTyping: source,
    scrollLongestTaskMs: Math.round(Math.max(0, ...lt)),
    scrollLongTasks: lt.length,
    verifyRunsDuringScroll: (await verifyRuns()) - verifyBefore,
    readerStatus: html.status(),
    readerKB: Math.round(readerBody.length / 1024),
    readerGzipKB: Math.round(gzipSync(readerBody).length / 1024),
    readerMs,
    readerRepeatMs: Math.round(pct(repeats, 0.5)),
  }),
);
await browser.close();
