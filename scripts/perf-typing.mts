// Measures typing latency on a large document in both panes against a running server.
import { chromium } from "@playwright/test";
const base = process.env.BASE_URL ?? "http://localhost:3000";
const section = (i: number) => `## Section ${i}\n\nParagraph ${i} with **bold**, *emphasis*, a [link](https://example.com/${i}) and \`code\`. The quick brown fox jumps over the lazy dog again and again.\n\n- item one\n- item two\n- [ ] task ${i}\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n\n`;
const content = "# Big document\n\n" + Array.from({ length: Number(process.env.SECTIONS ?? 250) }, (_, i) => section(i)).join("");
console.log("doc size:", content.length, "chars,", content.split("\n").length, "lines");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${base}/login`);
await page.getByTestId("dev-login").fill("perf");
await page.getByTestId("dev-login-submit").click();
await page.waitForURL(`${base}/`);
const res = await page.request.post(`${base}/api/documents`, { data: { content } });
const id = (await res.json()).document.id as string;
const t0 = Date.now();
await page.goto(`${base}/d/${id}`);
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 60000 });
await page.locator(".md-rich h1").waitFor();
console.log("open + sync:", Date.now() - t0, "ms");

async function measure(label: string, focus: () => Promise<void>) {
  await focus();
  await page.evaluate(() => {
    (window as unknown as { __long: number[] }).__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as unknown as { __long: number[] }).__long.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: true });
  });
  const start = Date.now();
  const n = 25;
  for (let i = 0; i < n; i++) await page.keyboard.type("x", { delay: 0 });
  await page.waitForTimeout(300);
  const elapsed = Date.now() - start - 300;
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  console.log(`${label}: ${Math.round(elapsed / n)} ms/keystroke avg; long tasks: ${long.length} (max ${Math.max(0, ...long)} ms)`);
}

await measure("rich pane ", async () => {
  await page.locator(".md-rich h1").click();
  await page.keyboard.press("End");
});
await measure("code pane ", async () => {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
});
await browser.close();
