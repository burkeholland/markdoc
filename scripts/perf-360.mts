// Task #360 measurement: outside-view 4-char token latency at the end of the Burke-scale hero doc,
// React commits per keystroke (EditorShell and the dialogs) and a CDP profile of 5 keystrokes + a
// 1.5 s pause (parse time under lint must be 0). Against a running server: BASE_URL=http://localhost:3812.
import { chromium, type Page } from "@playwright/test";
import { LONG_DOC } from "../e2e/fixtures/burke-scale";

const base = process.env.BASE_URL ?? "http://localhost:3812";
const label = process.env.LABEL ?? "after";
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface CommitRecord {
  rendered: string[];
  duration: number;
}
type Win = Window & { __commits: CommitRecord[]; __commitsOn: boolean };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// React DevTools hook stub: records, per commit, which components of interest performed work.
await context.addInitScript(() => {
  const w = window as unknown as Win & { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
  w.__commits = [];
  w.__commitsOn = false;
  const INTEREST = /^(EditorShell|StatusBar|OutlinePanel|OutlineList|Header|Toolbar|CodePane|RichPane|CommandPalette|SelectionBubble|TableMenu|SlashMenu|.*Dialog)$/;
  const renderers = new Map<number, unknown>();
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    inject(renderer: unknown) {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      return id;
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id: number, root: { current: FiberLike }) {
      if (!w.__commitsOn) return;
      const rendered: string[] = [];
      const stack: FiberLike[] = [root.current];
      while (stack.length) {
        const f = stack.pop()!;
        const t = f.type as FiberType | null;
        if (t && (typeof t === "function" || typeof t === "object")) {
          const inner = typeof t === "object" ? ((t as unknown as { type?: FiberType; render?: FiberType }).type ?? (t as unknown as { render?: FiberType }).render) : t;
          const name = (typeof inner === "function" && (inner.displayName || inner.name)) || (typeof t === "function" ? t.displayName || t.name : "") || "";
          if (name && INTEREST.test(name) && (f.flags & 1) !== 0) rendered.push(name);
        }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
      w.__commits.push({ rendered, duration: root.current.actualDuration ?? 0 });
    },
  };
  interface FiberLike {
    type: unknown;
    flags: number;
    child: FiberLike | null;
    sibling: FiberLike | null;
    actualDuration?: number;
  }
  type FiberType = ((...a: unknown[]) => unknown) & { displayName?: string; name?: string; type?: FiberType; render?: FiberType };
});
const page = await context.newPage();
await page.goto(`${base}/login`);
await page.getByTestId("dev-login").fill(`perf360-${label}`);
await page.getByTestId("dev-login-submit").click();
await page.waitForURL(`${base}/`);
const res = await page.request.post(`${base}/api/documents`, { data: { content: LONG_DOC, title: "Burke-scale hero doc (perf 360)" } });
const id = (await res.json()).document.id as string;
console.log(`[perf360 ${label}] hero doc ${id}: ${LONG_DOC.length} chars`);
const t0 = Date.now();
await page.goto(`${base}/d/${id}`);
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 60000 });
await page.locator(".md-rich h2").last().waitFor();
console.log(`[perf360 ${label}] open + sync: ${Date.now() - t0} ms`);

// Burke's position: the very end of the last paragraph, in the code pane.
if ((await page.getByTestId("outline").count()) === 0) await page.getByTestId("outline-button").click();
const items = page.getByTestId("outline").locator("[data-outline-item]");
await items.last().click();
await page.locator(".cm-content").click();
await page.keyboard.press("Control+End");
await page.waitForTimeout(2000); // let the open-time work (lint, verify parse) settle

async function token(page: Page, tok: string): Promise<number> {
  const t = Date.now();
  await page.keyboard.type(tok);
  await page.waitForFunction((m) => (document.querySelector(".md-rich")?.textContent ?? "").includes(m), tok, { timeout: 15000 });
  return Date.now() - t;
}

// 1. Outside view, 8 × 4-char token, back to back (the lead's method for #357).
const letters = "abcdefgh";
const backToBack: number[] = [];
for (let i = 0; i < 8; i++) backToBack.push(await token(page, `zq${letters[i]}${letters[(i + 3) % 8]}`));
console.log(`[perf360 ${label}] outside-view 4-char token, back to back ×8: median ${median(backToBack)} ms (${backToBack.join("/")})`);

// 2. Same with a 1.5 s pause between tokens: the lint debounce (500 ms) and the parse verification
// (1 s idle) land inside the pause, the way Burke types a paragraph.
const paused: number[] = [];
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(1500);
  paused.push(await token(page, `zp${letters[i]}${letters[(i + 5) % 8]}`));
}
console.log(`[perf360 ${label}] outside-view 4-char token, 1.5 s pause before each ×8: median ${median(paused)} ms max ${Math.max(...paused)} ms (${paused.join("/")})`);

const INCLUSIVE = ["syncFromText", "buildDoc", "reparseRange", "parseRegion", "parseMarkdown", "buildSourceMap", "minimalReplaceTransaction", "getSourceMap", "getHeadings", "getTree", "lintMarkdown", "verifyParse", "handleLocalTransaction", "formatState", "collectHighlights", "applyHighlights", "refreshRichHighlights", "updateState", "performWorkUntilDeadline", "performSyncWorkOnRoot", "performWorkOnRoot", "flushSyncWorkAcrossRoots_impl", "commitRoot", "renderRootSync", "textChangeSpan", "countNewlines", "toString", "shiftMdast"];
// 2b. Same again under the CDP profiler: how much full parsing (verifyParse) lands in the pauses.
// Sampled at 1 ms so the profiler itself does not distort the tokens.
{
  await page.waitForTimeout(1500);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  const profiled: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1500);
    profiled.push(await token(page, `zv${letters[i]}${letters[(i + 2) % 8]}`));
  }
  await page.waitForTimeout(1500);
  const { profile } = await cdp.send("Profiler.stop");
  await cdp.detach();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const deltas = profile.timeDeltas ?? [];
  let verify = 0;
  let fullParse = 0;
  let anyParse = 0;
  let idle = 0;
  const inclusive = new Map<string, number>();
  const self = new Map<string, number>();
  for (let i = 0; i < profile.samples!.length; i++) {
    const ms = (deltas[i] ?? 0) / 1000;
    const cf = byId.get(profile.samples![i])!.callFrame;
    if (cf.functionName === "(idle)") idle += ms;
    const selfKey = `${cf.functionName || "(anon)"} @ ${cf.url.replace(/^.*\/_next\/static\/chunks\//, "").replace(/\?.*$/, "").slice(-40)}`;
    self.set(selfKey, (self.get(selfKey) ?? 0) + ms);
    let underVerify = false;
    let underParse = false;
    let underIncremental = false;
    const seen = new Set<string>();
    for (let p: number | undefined = profile.samples![i]; p !== undefined; p = parent.get(p)) {
      const n = byId.get(p)!.callFrame.functionName;
      if (n === "verifyParse") underVerify = true;
      if (n === "parseMarkdown") underParse = true;
      if (n === "reparseRange" || n === "parseRegion") underIncremental = true;
      if (INCLUSIVE.includes(n) && !seen.has(n)) {
        seen.add(n);
        inclusive.set(n, (inclusive.get(n) ?? 0) + ms);
      }
    }
    if (underVerify) verify += ms;
    if (underParse) anyParse += ms;
    if (underParse && !underIncremental) fullParse += ms;
  }
  const total = (profile.endTime - profile.startTime) / 1000;
  console.log(`[perf360 ${label}] profiled 1.5 s pause ×8: median ${median(profiled)} ms max ${Math.max(...profiled)} ms (${profiled.join("/")}) · verifyParse ${verify.toFixed(0)} ms · parseMarkdown full ${fullParse.toFixed(0)} ms, any ${anyParse.toFixed(0)} ms · ${Math.round(total - idle)} ms busy of ${Math.round(total)}`);
  console.log(`[perf360 ${label}]   inclusive: ${[...inclusive.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ")}`);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [k, v] of top) console.log(`[perf360 ${label}]   ${String(Math.round(v)).padStart(6)} ms  ${k}`);
}
if (process.env.QUICK) {
  await browser.close();
  process.exit(0);
}

// 3. React commits per keystroke (dev React, via the DevTools hook): 8 single keystrokes, 300 ms apart.
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const w = window as unknown as Win;
  w.__commits = [];
  w.__commitsOn = true;
});
for (let i = 0; i < 8; i++) {
  await page.keyboard.type(String(i));
  await page.waitForTimeout(300);
}
await page.waitForTimeout(700);
const commits = await page.evaluate(() => {
  const w = window as unknown as Win;
  w.__commitsOn = false;
  return w.__commits;
});
const counts = new Map<string, number>();
let reactMs = 0;
for (const c of commits) {
  reactMs += c.duration;
  for (const n of c.rendered) counts.set(n, (counts.get(n) ?? 0) + 1);
}
console.log(`[perf360 ${label}] 8 keystrokes → ${commits.length} React commits, ${reactMs.toFixed(1)} ms actualDuration total (${(reactMs / 8).toFixed(1)} ms per keystroke)`);
console.log(`[perf360 ${label}]   components that rendered (commits): ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join(" ") || "(none of interest)"}`);
console.log(`[perf360 ${label}]   EditorShell commits per keystroke: ${((counts.get("EditorShell") ?? 0) / 8).toFixed(2)}`);

// 4. CDP profile: 5 keystrokes + 1.5 s pause. Self time by function, and everything under lintMarkdown.
await page.waitForTimeout(1500);
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
async function profileKeystrokes(name: string, keys: number, pauseMs: number) {
  await cdp.send("Profiler.start");
  for (let i = 0; i < keys; i++) await page.keyboard.type("x", { delay: 0 });
  await page.waitForTimeout(pauseMs);
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let lintTotal = 0;
  let parseUnderLint = 0;
  let parseMdastSelf = 0;
  let idle = 0;
  const deltas = profile.timeDeltas ?? [];
  const fnName = (id: number) => byId.get(id)!.callFrame.functionName;
  for (let i = 0; i < profile.samples!.length; i++) {
    const ms = (deltas[i] ?? 0) / 1000;
    const node = byId.get(profile.samples![i])!;
    const cf = node.callFrame;
    if (cf.functionName === "(idle)") idle += ms;
    const url = cf.url.replace(/^.*\/_next\/static\/chunks\//, "").replace(/\?.*$/, "");
    const key = `${cf.functionName || "(anon)"} @ ${url.slice(-40)}`;
    self.set(key, (self.get(key) ?? 0) + ms);
    if (cf.functionName === "parseMdast") parseMdastSelf += ms;
    let underLint = false;
    let underParse = false;
    const seen = new Set<string>();
    for (let p = node.id; p !== undefined; p = parent.get(p)!) {
      const n = fnName(p);
      if (n === "lintMarkdown") underLint = true;
      if (n === "parseMdast" || n === "fromMarkdown") underParse = true;
      if (INCLUSIVE.includes(n) && !seen.has(n)) {
        seen.add(n);
        inclusive.set(n, (inclusive.get(n) ?? 0) + ms);
      }
      if (!parent.has(p)) break;
    }
    if (underLint) lintTotal += ms;
    if (underLint && underParse) parseUnderLint += ms;
  }
  const total = (profile.endTime - profile.startTime) / 1000;
  const react = ["performWorkUntilDeadline", "performSyncWorkOnRoot", "performWorkOnRoot", "flushSyncWorkAcrossRoots_impl"].reduce((s, k) => s + (inclusive.get(k) ?? 0), 0);
  console.log(`[perf360 ${label}] profile "${name}": ${keys} keystrokes + ${pauseMs} ms pause = ${Math.round(total)} ms sampled, ${Math.round(idle)} ms idle, ${Math.round(total - idle)} ms busy`);
  console.log(`[perf360 ${label}]   lintMarkdown total ${lintTotal.toFixed(1)} ms · parse (parseMdast/fromMarkdown) under lint ${parseUnderLint.toFixed(1)} ms · parseMdast self ${parseMdastSelf.toFixed(1)} ms · React (scheduler roots, upper bound) ${react.toFixed(1)} ms`);
  console.log(`[perf360 ${label}]   inclusive: ${[...inclusive.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ")}`);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [k, v] of top) console.log(`[perf360 ${label}]   ${String(Math.round(v)).padStart(6)} ms  ${k}`);
}
await profileKeystrokes("keystrokes + pause", 5, 1500);
await page.waitForTimeout(1500);
await profileKeystrokes("keystrokes only", 5, 200);

// 5. The issues badge updates within 600 ms of the pause.
await page.waitForTimeout(1500);
await page.keyboard.type(" [x][nowhere]");
const tIssue = Date.now();
await page.waitForFunction(() => /\d+ issues?/.test(document.querySelector('[data-testid="issues-button"]')?.textContent ?? ""), undefined, { timeout: 5000 });
console.log(`[perf360 ${label}] issues badge after typing "[x][nowhere]": ${Date.now() - tIssue} ms (includes the 500 ms debounce)`);

await browser.close();
