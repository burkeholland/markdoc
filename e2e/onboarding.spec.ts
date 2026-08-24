import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, selectTextInRich, shareWith, type User } from "./helpers";

/**
 * Task #385 — first-run path: the guided Welcome doc from the empty dashboard, the once-only hint
 * bar under the toolbar (localStorage `markdoc:hints`), and the Copilot CLI setup checklist in Settings.
 */

const fresh = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

const readHints = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("markdoc:hints") ?? "null") as { dismissed: string[]; agentSeen: boolean } | null);

const SELECTION = "Select any text and press"; // 25 chars, a single text node in the Welcome doc

test.describe("onboarding: guided Welcome doc", () => {
  test("a fresh user reaches a real document with the three tasks in two clicks; a user with documents never sees the empty state", async ({ browser }) => {
    const user = await signIn(browser, fresh("onboard"));
    const page = user.page;
    const empty = page.getByTestId("empty-state");
    await expect(empty).toBeVisible();
    // The existing actions are still there; the guided doc is the primary one.
    await expect(page.getByTestId("new-document")).toBeVisible();
    await expect(page.getByTestId("new-from-template")).toBeVisible();
    await expect(empty.getByTestId("template-grid")).toBeVisible();
    // Hidden from the picker: the welcome template is not a card.
    await expect(empty.getByTestId("template-welcome")).toHaveCount(0);
    await page.screenshot({ path: "shots/onboarding-empty-state.png", fullPage: false });

    // Click 1 (after the sign-in click): one primary action creates and opens the document.
    await page.getByTestId("start-guided-doc").click();
    await page.waitForURL(/\/d\/[a-z0-9]+$/i);
    await expect(page.getByTestId("title")).toContainText("Welcome to Markdoc");
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    const rich = page.locator(".md-rich");
    await expect(rich.locator("h1")).toHaveText("Welcome to Markdoc");
    await expect(rich.locator("h2")).toHaveCount(4);
    await expect(rich.getByRole("checkbox")).toHaveCount(3);
    await expect(rich).toContainText("Type / here for a block menu");
    await expect(rich).toContainText("Select this sentence and press Comment");
    await expect(rich).toContainText("Delete this doc when you're done — it's just a doc.");
    await page.screenshot({ path: "shots/onboarding-welcome-doc.png", fullPage: false });

    // Back home: it is a real document in the list, and the empty state is gone for good.
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("document-list")).toBeVisible();
    await expect(page.getByTestId("document-card")).toHaveCount(1);
    await expect(page.getByTestId("empty-state")).toHaveCount(0);
    await expect(page.getByTestId("start-guided-doc")).toHaveCount(0);
    await user.context.close();
  });

  test("a user who already has documents never sees the empty state or the guided action", async ({ browser }) => {
    const user = await signIn(browser, fresh("has-docs"));
    await createDocument(user.page, "# Existing\n\nBody.\n", "Existing");
    await user.page.goto("/");
    await user.page.waitForLoadState("networkidle");
    await expect(user.page.getByTestId("document-list")).toBeVisible();
    await expect(user.page.getByTestId("empty-state")).toHaveCount(0);
    await expect(user.page.getByTestId("start-guided-doc")).toHaveCount(0);
    await user.context.close();
  });

  test("GET /api/templates does not list the welcome template; POST /api/documents still creates it by id", async ({ browser }) => {
    const user = await signIn(browser, fresh("tpl-api"));
    const list = (await (await user.page.request.get("/api/templates")).json()) as { templates: { id: string }[] };
    expect(list.templates.map((t) => t.id)).not.toContain("welcome");
    expect(list.templates).toHaveLength(8);
    const res = await user.page.request.post("/api/documents", { data: { template: "welcome" } });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { document: { title: string } };
    expect(body.document.title).toBe("Welcome to Markdoc");
    await user.context.close();
  });
});

test.describe("onboarding: hint bar", () => {
  let alice: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, fresh("hints"));
    const res = await alice.page.request.post("/api/documents", { data: { template: "welcome" } });
    expect(res.ok()).toBeTruthy();
    docId = ((await res.json()) as { document: { id: string } }).document.id;
    await openDocument(alice.page, docId);
  });

  test.afterAll(async () => {
    await alice.context.close();
  });

  test("no hint in a fresh, solo document until a gate opens; (b) appears on a 20+ char selection and its button opens Ask an agent", async () => {
    const page = alice.page;
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);
    // A short selection is not enough.
    await selectTextInRich(page, "Markdoc is built");
    await page.waitForTimeout(200);
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);

    await selectTextInRich(page, SELECTION);
    const bar = page.getByTestId("hint-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-hint", "ask-agent");
    await expect(bar).toHaveAttribute("aria-live", "polite");
    await expect(bar).toContainText("Ask an agent");
    await page.screenshot({ path: "shots/onboarding-hint-ask-agent.png", fullPage: false });

    // Collapsing the selection does not pull the hint away (it is pinned until acted on).
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    await expect(bar).toBeVisible();

    await selectTextInRich(page, SELECTION);
    await page.getByTestId("hint-action").click();
    const dialog = page.getByTestId("ask-agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(SELECTION);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Acting on a hint dismisses it: shown once, and remembered.
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);
    expect((await readHints(page))?.dismissed).toEqual(["ask-agent"]);
    await selectTextInRich(page, SELECTION);
    await page.waitForTimeout(200);
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);
  });

  test("(a) appears once the doc has a collaborator and no agent was ever seen; ✕ is keyboard reachable and persists across reload", async ({ browser }) => {
    const page = alice.page;
    const bob = await signIn(browser, fresh("hints-bob"));
    await shareWith(page, docId, bob.login, "editor");
    await bob.context.close();
    await openDocument(page, docId);
    const bar = page.getByTestId("hint-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-hint", "collab-agent");
    await expect(bar).toContainText("Collaborate with an agent");
    // The action opens Share.
    await page.getByTestId("hint-action").focus();
    await expect(page.getByTestId("hint-action")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("hint-dismiss")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("share-login")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-login")).toHaveCount(0);
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);
    expect((await readHints(page))?.dismissed.sort()).toEqual(["ask-agent", "collab-agent"]);

    // Reload: still dismissed, even though the gate (a collaborator) is still true.
    await openDocument(page, docId);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);
  });

  test("(c) appears with the first comment thread; ✕ dismisses it; with all three dismissed the bar never returns", async () => {
    const page = alice.page;
    const res = await page.request.post(`/api/documents/${docId}/comments`, { data: { action: "add", quote: "Headings build the outline", body: "First thread" } });
    expect(res.ok()).toBeTruthy();
    const bar = page.getByTestId("hint-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-hint", "mention-copilot");
    await expect(bar).toContainText("@-mention Copilot");
    await page.getByTestId("hint-dismiss").click();
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);
    expect((await readHints(page))?.dismissed.sort()).toEqual(["ask-agent", "collab-agent", "mention-copilot"]);

    // Every gate is open now (collaborator, long selection, thread) and nothing comes back, reload included.
    await openDocument(page, docId);
    await selectTextInRich(page, SELECTION);
    await page.waitForTimeout(400);
    await expect(page.getByTestId("hint-bar")).toHaveCount(0);
  });

  test("(c) action opens Comments and focuses a composer; hints never show on phone widths", async ({ browser }) => {
    const carol = await signIn(browser, fresh("hints-carol"));
    const id = await createDocument(carol.page, "# Threads\n\nA paragraph to comment on with enough words in it.\n", "Threads");
    const res = await carol.page.request.post(`/api/documents/${id}/comments`, { data: { action: "add", quote: "A paragraph to comment on", body: "Hello" } });
    expect(res.ok()).toBeTruthy();
    await openDocument(carol.page, id);
    const bar = carol.page.getByTestId("hint-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-hint", "mention-copilot");
    await carol.page.getByTestId("hint-action").click();
    await expect(carol.page.getByTestId("comments-panel")).toBeVisible();
    await expect(carol.page.getByTestId("comments-panel").getByTestId("comment-composer").first()).toBeFocused();
    await expect(carol.page.getByTestId("hint-bar")).toHaveCount(0);

    // Phone: the other two gates are open, the bar stays away (the phone layout shows the preview only).
    await carol.page.evaluate(() => localStorage.removeItem("markdoc:hints"));
    await carol.page.setViewportSize({ width: 600, height: 900 });
    await carol.page.goto(`/d/${id}`);
    await expect(carol.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(carol.page.locator(".md-rich")).toBeVisible();
    await expect(carol.page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone");
    await carol.page.waitForTimeout(400);
    await expect(carol.page.getByTestId("hint-bar")).toHaveCount(0);
    await carol.context.close();
  });
});

test.describe("onboarding: Settings checklist", () => {
  test("a minted token and a tools/list over /api/mcp turn the first two items green; a tools/call turns the rest", async ({ browser }) => {
    const user = await signIn(browser, fresh("checklist"));
    const page = user.page;
    await page.goto("/settings");
    const list = page.getByTestId("copilot-checklist");
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute("data-done", "0");
    for (const id of ["token", "config", "allow", "try"]) await expect(page.getByTestId(`checklist-${id}`)).toHaveAttribute("data-done", "false");

    const minted = await page.request.post("/api/tokens", { data: { name: "Copilot CLI", expiresInDays: 30 } });
    expect(minted.ok()).toBeTruthy();
    const token = ((await minted.json()) as { token: { token: string } }).token.token;
    const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const listed = await page.request.post("/api/mcp", { headers, data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect(listed.ok()).toBeTruthy();

    // The list polls /api/tokens; no reload needed.
    await expect(page.getByTestId("checklist-token")).toHaveAttribute("data-done", "true", { timeout: 15_000 });
    await expect(page.getByTestId("checklist-config")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("checklist-allow")).toHaveAttribute("data-done", "false");
    await expect(page.getByTestId("checklist-try")).toHaveAttribute("data-done", "false");
    await expect(list).toHaveAttribute("data-done", "2");

    const called = await page.request.post("/api/mcp", { headers, data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "markdoc_whoami", arguments: {} } } });
    expect(called.ok()).toBeTruthy();
    await expect(page.getByTestId("checklist-allow")).toHaveAttribute("data-done", "true", { timeout: 15_000 });
    await expect(page.getByTestId("checklist-try")).toHaveAttribute("data-done", "true");
    await expect(list).toHaveAttribute("data-done", "4");
    // Persisted on the token row (not just in this tab's state): what a reload would render.
    const tokens = (await (await page.request.get("/api/tokens")).json()) as { tokens: { lastMcpSeenAt: string | null; lastMcpCallAt: string | null }[] };
    expect(tokens.tokens[0].lastMcpSeenAt).toMatch(/^\d{4}-/);
    expect(tokens.tokens[0].lastMcpCallAt).toMatch(/^\d{4}-/);
    await user.context.close();
  });
});
