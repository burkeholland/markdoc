// Quick manual smoke run: sign in with the dev login, create a document, take screenshots.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
fs.mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log("[browser]", m.type(), m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(`${base}/login`);
await page.getByTestId("dev-login").fill("burke");
await page.getByTestId("dev-login-submit").click();
await page.waitForURL(`${base}/`);
await page.screenshot({ path: "shots/dashboard.png" });
console.log("dashboard ok");

await page.waitForLoadState("networkidle");
const newDoc = page.getByTestId("new-document");
await newDoc.click();
await page.waitForURL(/\/d\//, { timeout: 20000 }).catch(async () => {
  await newDoc.click();
  await page.waitForURL(/\/d\//, { timeout: 20000 });
});
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 20000 });
await page.screenshot({ path: "shots/editor.png" });
console.log("editor ok", page.url());

// Type in the rich pane and check the code pane follows.
const rich = page.locator(".md-rich");
await rich.click();
await page.keyboard.press("End");
await page.keyboard.type(" Hello from the rich pane.");
await page.waitForTimeout(300);
const code = await page.locator(".cm-content").innerText();
console.log("code contains rich text:", code.includes("Hello from the rich pane."));

// Type in the code pane and check the rich pane follows.
await page.locator(".cm-content").click();
await page.keyboard.press("Control+End");
await page.keyboard.type("\n\n## From the code pane\n\n- [ ] a task\n");
await page.waitForTimeout(400);
const richText = await rich.innerText();
console.log("rich contains code text:", richText.includes("From the code pane"), "task:", (await page.locator(".md-task-item").count()) > 0);
await page.screenshot({ path: "shots/editor-after-typing.png" });
await browser.close();

