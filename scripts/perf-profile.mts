// CPU profile of typing in the rich pane on a large document (top self-time functions).
import { chromium } from "@playwright/test";
const base = process.env.BASE_URL ?? "http://localhost:3000";
const section = (i: number) => `## Section ${i}\n\nParagraph ${i} with **bold**, *emphasis*, a [link](https://example.com/${i}) and \`code\`. The quick brown fox jumps over the lazy dog again and again.\n\n- item one\n- item two\n- [ ] task ${i}\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n\n`;
const content = "# Big document\n\n" + Array.from({ length: 250 }, (_, i) => section(i)).join("");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${base}/login`);
await page.getByTestId("dev-login").fill("perf");
await page.getByTestId("dev-login-submit").click();
await page.waitForURL(`${base}/`);
const res = await page.request.post(`${base}/api/documents`, { data: { content } });
const id = (await res.json()).document.id as string;
await page.goto(`${base}/d/${id}`);
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 60000 });
await page.locator(".md-rich h1").click();
await page.keyboard.press("End");
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await cdp.send("Profiler.start");
for (let i = 0; i < 10; i++) await page.keyboard.type("x", { delay: 0 });
await page.waitForTimeout(500);
const { profile } = await cdp.send("Profiler.stop");
// Aggregate self time by function.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map<string, number>();
const total = (profile.endTime - profile.startTime) / 1000;
const deltas = profile.timeDeltas ?? [];
for (let i = 0; i < profile.samples!.length; i++) {
  const node = byId.get(profile.samples![i])!;
  const cf = node.callFrame;
  const url = cf.url.replace(/^.*\/_next\/static\/chunks\//, "").replace(/\?.*$/, "");
  const key = `${cf.functionName || "(anon)"} @ ${url.slice(0, 60)}`;
  self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log(`profiled ${Math.round(total)} ms total`);
for (const [k, v] of top) console.log(`${String(Math.round(v)).padStart(6)} ms  ${k}`);
await browser.close();
