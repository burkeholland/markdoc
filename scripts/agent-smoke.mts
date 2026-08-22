// Creates an API token through the settings UI, then acts as an agent with it against the running server.
import { chromium, expect } from "@playwright/test";
const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/login`);
if (await page.getByTestId("dev-login").count()) {
  await page.getByTestId("dev-login").fill("agent-smoke");
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL(`${base}/`);
}
await page.goto(`${base}/settings`);
await page.waitForResponse((r) => r.url().endsWith("/api/tokens") && r.request().method() === "GET");
await page.waitForTimeout(300);
await page.getByTestId("token-name").fill("Smoke agent");
await page.getByTestId("token-create").click();
await page.getByTestId("token-created").waitFor();
const token = (await page.getByTestId("copy-token").innerText()).trim();
console.log("token prefix:", token.slice(0, 10));
await browser.close();

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const me = await (await fetch(`${base}/api/me`, { headers })).json();
console.log("me:", me);
expect(me.agent).toBe("Smoke agent");
const created = await (await fetch(`${base}/api/documents`, { method: "POST", headers, body: JSON.stringify({ content: "# From an agent\n\nHello, humans.\n" }) })).json();
console.log("created doc:", created.document);
const list = await (await fetch(`${base}/api/documents`, { headers })).json();
expect(list.documents.some((d: { id: string }) => d.id === created.document.id)).toBe(true);
const named = await (await fetch(`${base}/api/documents/${created.document.id}/versions`, { method: "POST", headers, body: JSON.stringify({ title: "Agent checkpoint" }) })).json();
console.log("version by:", named.version.createdByName);
expect(named.version.createdByName).toBe("agent-smoke via Smoke agent");
const bad = await fetch(`${base}/api/me`, { headers: { Authorization: "Bearer mdk_" + "z".repeat(40) } });
expect(bad.status).toBe(401);
const noMint = await fetch(`${base}/api/tokens`, { method: "POST", headers, body: JSON.stringify({ name: "nope" }) });
expect(noMint.status).toBe(403);
console.log("ALL GOOD");


