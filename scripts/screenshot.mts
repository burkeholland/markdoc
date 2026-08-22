// Produces docs/screenshot.png: the editor with the sample document, two collaborators and a comment.
// Usage: start a server first (e.g. PORT=3100 ... npx tsx server/index.ts), then BASE_URL=http://localhost:3100 npx tsx scripts/screenshot.mts
import { chromium, type Page } from "@playwright/test";
import fs from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3100";
fs.mkdirSync("docs", { recursive: true });

const SAMPLE = `# Project Notes

Welcome to the **Project Notes** document. Use this space to plan, track progress, and capture important decisions. See the [project roadmap](https://example.com/roadmap) for context.

## Goals

- Deliver value to our users
- Maintain code quality
- Ship consistently

## Tasks

- [x] Define project scope
- [x] Set up repository
- [ ] Implement core features
- [ ] Write documentation

## Example

Here's a simple JavaScript function:

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`
`;

const browser = await chromium.launch();
async function signIn(login: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL(`${base}/`);
  return page;
}

const burke = await signIn("burkeholland");
const ada = await signIn("ada");
const res = await burke.request.post(`${base}/api/documents`, { data: { content: SAMPLE, title: "Project Notes" } });
const id = (await res.json()).document.id as string;
await burke.request.post(`${base}/api/documents/${id}/collaborators`, { data: { login: "ada", role: "editor" } });

for (const p of [burke, ada]) {
  await p.goto(`${base}/d/${id}`);
  await p.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 30000 });
}
// Ada parks her caret in the Goals list so it shows up in Burke's editors.
await ada.locator(".md-rich li").nth(1).click();
await ada.keyboard.press("End");
await burke.waitForTimeout(600);
await burke.locator(".cm-content").click();
await burke.locator(".cm-line").nth(5).click();
await burke.waitForTimeout(400);
await burke.screenshot({ path: "docs/screenshot.png" });
console.log("wrote docs/screenshot.png");
await browser.close();
