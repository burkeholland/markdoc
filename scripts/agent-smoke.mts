// Agent collaboration smoke: mints a token in the UI, then acts as an agent against the running server
// while a browser watches the document. Usage: BASE_URL=http://localhost:3000 npx tsx scripts/agent-smoke.mts
import { chromium, expect } from "@playwright/test";
const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return data;
};

console.log("== identity");
const me = await call("GET", "/api/me");
expect(me.agent).toBe("Smoke agent");

console.log("== create + live replace");
const created = await call("POST", "/api/documents", { content: "# Draft\n\nFirst version by the agent.\n" });
const id = created.document.id as string;
await page.goto(`${base}/d/${id}`);
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 30000 });
await call("PUT", `/api/documents/${id}/content`, { content: "# Draft\n\nSecond version by the agent.\n\n## Next steps\n\n- Review\n", message: "Agent revision" });
await expect(page.locator(".md-rich")).toContainText("Second version by the agent.");
await expect(page.getByTestId("agent-activity")).toContainText("Smoke agent");
console.log("live replace visible in the browser, bot chip shown");

console.log("== append");
await call("PATCH", `/api/documents/${id}/content`, { append: "- Ship" });
await expect(page.locator(".md-rich li").last()).toHaveText("Ship");

console.log("== suggestions from a revised text");
const current = await call("GET", `/api/documents/${id}/content`);
const revised = (current.content as string).replace("Second version", "Improved version").replace("- Ship", "- Ship it to everyone");
const sug = await call("POST", `/api/documents/${id}/suggest`, { content: revised });
console.log("suggestions created:", sug.suggestions);
await expect(page.locator(".md-rich .md-suggest-insert").first()).toBeVisible();
const list = await call("GET", `/api/documents/${id}/suggestions`);
console.log("pending:", list.suggestions.map((s: { type: string; text: string; author: string }) => `${s.type}:${JSON.stringify(s.text)} by ${s.author}`));
expect(list.suggestions.every((s: { author: string }) => s.author === "Smoke agent")).toBe(true);
await call("POST", `/api/documents/${id}/suggest`, { edits: [{ find: "Review", replace: "Review with the team" }] });

console.log("== comments by quote, then read them back");
const c = await call("POST", `/api/documents/${id}/comments`, { action: "add", quote: "Next steps", body: "Should this be a numbered list?" });
const comments = await call("GET", `/api/documents/${id}/comments`);
expect(comments.comments.some((t: { id: string; author: string; currentText: string }) => t.id === c.id && t.author === "Smoke agent" && t.currentText === "Next steps")).toBe(true);
await expect(page.getByTestId("comments-badge")).toHaveText("1");

console.log("== human accepts everything in the UI");
await page.getByTestId("comments-toggle").click();
await page.getByTestId("comments-tab-suggestions").click();
await page.screenshot({ path: "docs/agent-review.png" });
await page.getByTestId("accept-all").click();
await expect.poll(async () => (await call("GET", `/api/documents/${id}/suggestions`)).suggestions.length).toBe(0);
const final = await call("GET", `/api/documents/${id}/content`);
expect(final.content).toContain("Improved version");
expect(final.content).toContain("Ship it to everyone");
expect(final.content).toContain("Review with the team");
const versions = await call("GET", `/api/documents/${id}/versions`);
console.log("versions:", versions.versions.map((v: { kind: string; title: string | null; createdByName: string | null }) => `${v.kind}:${v.title} (${v.createdByName})`));
expect(versions.versions.some((v: { title: string | null }) => v.title === "Agent revision")).toBe(true);

console.log("== ask an agent: request loop (UI route → token inbox → claim → suggest with requestId → complete)");
// The human asks from the document (session cookie); the agent answers through the token.
const askRes = await page.request.post(`${base}/api/documents/${id}/requests`, {
  data: { instruction: "Tighten this", mode: "suggest", selection: { from: 0, to: 7, quote: "# Draft" } },
});
expect(askRes.status()).toBe(201);
const ask = ((await askRes.json()) as { request: { id: string; status: string } }).request;
expect(ask.status).toBe("open");
await expect(page.getByTestId("agent-requests-pill")).toContainText("1 request waiting");
const inbox = await call("GET", "/api/agent/requests?status=open");
expect(inbox.agent).toBe("Smoke agent");
expect(inbox.requests.some((r: { id: string }) => r.id === ask.id)).toBe(true);
await call("POST", `/api/documents/${id}/requests/${ask.id}/claim`);
await expect(page.getByTestId("agent-requests-pill")).toContainText("Smoke agent is working");
const linked = await call("POST", `/api/documents/${id}/suggest`, { edits: [{ find: "# Draft", replace: "# Launch draft" }], requestId: ask.id });
expect(linked.suggestions).toBeGreaterThan(0);
const doneReq = await call("POST", `/api/documents/${id}/requests/${ask.id}/complete`, { summary: "Sharper title." });
expect(doneReq.request.status).toBe("done");
expect(doneReq.request.result.suggestions).toBe(linked.suggestions);
await expect(page.getByTestId("agent-requests-pill")).toHaveCount(0);
await expect(page.getByTestId("toast").filter({ hasText: "Smoke agent finished" })).toBeVisible();
const notes = await page.request.get(`${base}/api/notifications?unread=1`);
const noteItems = ((await notes.json()) as { items: { kind: string; refId: string }[] }).items;
expect(noteItems.some((n) => n.kind === "request.done" && n.refId === ask.id)).toBe(true);
console.log("request loop: done, suggestions =", linked.suggestions, "notification row present");

console.log("== auth hygiene");
expect((await fetch(`${base}/api/me`, { headers: { Authorization: "Bearer mdk_" + "z".repeat(40) } })).status).toBe(401);
expect((await fetch(`${base}/api/tokens`, { method: "POST", headers, body: JSON.stringify({ name: "nope" }) })).status).toBe(403);
await browser.close();
console.log("ALL GOOD", `${base}/d/${id}`);
