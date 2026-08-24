import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, selectTextInRich, type User } from "./helpers";

interface EventsDto {
  cursor: string;
  events: { type: string; threadId?: string | null; author?: string; body?: string; snippet?: string; agent?: string | null }[];
}

/** Act as an agent: the same REST calls Copilot CLI makes through mcp/server.mjs (markdoc_presence / markdoc_watch / markdoc_suggest). */
function agent(page: Page, token: string) {
  const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
  return {
    presence: async (docId: string, body: { state: "active" | "idle" | "left"; status?: string; anchor?: string; cursor?: { from: number; to: number } | null }) => {
      const res = await page.request.post(`/api/agent/documents/${docId}/presence`, { headers, data: body });
      expect(res.ok(), `presence -> ${res.status()} ${await res.text()}`).toBeTruthy();
      return (await res.json()) as { presence: { name: string; status: string | null; cursor: { from: number; to: number } | null } | null };
    },
    suggest: async (docId: string, edits: { find: string; replace: string }[]) => {
      const res = await page.request.post(`/api/documents/${docId}/suggest`, { headers, data: { edits } });
      expect(res.ok(), `suggest -> ${res.status()} ${await res.text()}`).toBeTruthy();
      return (await res.json()) as { suggestions: number };
    },
    events: async (docId: string, since?: string, wait = 0) => {
      const q = new URLSearchParams();
      if (since) q.set("since", since);
      if (wait) q.set("wait", String(wait));
      const res = await page.request.get(`/api/agent/documents/${docId}/events?${q}`, { headers, timeout: 70_000 });
      expect(res.ok(), `events -> ${res.status()} ${await res.text()}`).toBeTruthy();
      return (await res.json()) as EventsDto;
    },
  };
}

test.describe("agent presence and watch", () => {
  let alice: User;
  let docId: string;
  let token: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    const res = await alice.page.request.post("/api/tokens", { data: { name: "Copilot", expiresInDays: 30 } });
    expect(res.ok()).toBeTruthy();
    token = ((await res.json()) as { token: { token: string } }).token.token;
    docId = await createDocument(alice.page, "# Presence doc\n\nFirst paragraph for the agent to watch.\n\nSecond paragraph.\n", "Presence doc");
    await openDocument(alice.page, docId);
  });

  test.afterAll(async () => {
    await alice.context.close();
  });

  test("an agent heartbeat shows a bot avatar with its status in the header; left removes it", async () => {
    const page = alice.page;
    const bot = agent(page, token);
    await expect(page.getByTestId("presence").getByTestId("presence-avatar")).toHaveCount(1);

    await bot.presence(docId, { state: "active", status: "drafting" });
    const avatar = page.getByTestId("presence").locator('[data-testid="presence-avatar"][data-agent]');
    await expect(avatar).toHaveCount(1, { timeout: 3000 });
    await expect(page.getByTestId("presence")).toHaveAttribute("aria-label", /Copilot \(agent: drafting\)/);

    await page.getByTestId("presence").click();
    const popover = page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    const row = popover.locator('[data-testid="presence-row"][data-agent]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Copilot");
    await expect(row).toContainText("Agent");
    await expect(row.getByTestId("presence-status")).toHaveText("drafting");
    await page.screenshot({ path: "test-results/agent-presence-header.png", clip: { x: 0, y: 0, width: 1280, height: 420 } });

    // A status update is live too.
    await bot.presence(docId, { state: "active", status: "reading comments" });
    await expect(row.getByTestId("presence-status")).toHaveText("reading comments", { timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(popover).not.toBeVisible();

    await bot.presence(docId, { state: "left" });
    await expect(avatar).toHaveCount(0, { timeout: 3000 });
    await expect(page.getByTestId("presence").getByTestId("presence-avatar")).toHaveCount(1);
  });

  test("a long-poll returns comment.added when a person comments in the UI", async () => {
    const page = alice.page;
    const bot = agent(page, token);
    const { cursor, events } = await bot.events(docId);
    expect(events).toEqual([]);

    const started = Date.now();
    const waiting = bot.events(docId, cursor, 30);
    await page.waitForTimeout(300);
    await selectTextInRich(page, "First paragraph");
    await page.getByTestId("tb-comment").click();
    await page.getByTestId("comment-composer").fill("Agent, can you expand this?");
    await page.getByTestId("comment-submit").click();
    await expect(page.getByTestId("comment-thread")).toHaveCount(1);

    const result = await waiting;
    expect(Date.now() - started).toBeLessThan(25_000);
    const added = result.events.find((e) => e.type === "comment.added");
    expect(added, JSON.stringify(result.events)).toBeTruthy();
    expect(added).toMatchObject({ author: "alice", body: "Agent, can you expand this?" });
    expect(added!.threadId).toBeTruthy();

    // Nothing is delivered twice.
    const again = await bot.events(docId, result.cursor);
    expect(again.events.filter((e) => e.type === "comment.added")).toEqual([]);
  });

  test("typing @ in a comment offers the present agent; picking it posts a bot chip and wakes the agent's watch with a mention", async () => {
    const page = alice.page;
    const bot = agent(page, token);
    const { cursor } = await bot.events(docId);
    const waiting = bot.events(docId, cursor, 30);
    await page.waitForTimeout(200);

    const announced = Date.now();
    await bot.presence(docId, { state: "idle", status: "waiting for feedback" });
    await selectTextInRich(page, "Second paragraph");
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await page.keyboard.type("@Cop");
    const option = page.getByTestId("mention-suggestions").locator('[data-testid="mention-option"][data-agent]');
    // Present agents come through awareness: the picker knows the agent within a second of its heartbeat.
    await expect(option).toHaveCount(1, { timeout: Math.max(250, 1000 - (Date.now() - announced)) });
    await expect(option).toContainText("Copilot");
    await expect(option).toContainText("agent");
    await expect(option).toHaveAttribute("data-login", "alice/Copilot");
    await page.screenshot({ path: "test-results/agent-mention-picker.png" });
    await page.keyboard.press("Enter");
    // Alice owns the token: the mention is not suppressed as a self-mention (the agent needs it).
    await expect(composer).toHaveValue("@alice/Copilot ");
    await page.keyboard.type("tighten this");
    const posted = Date.now();
    await page.getByTestId("comment-submit").click();
    const thread = page.getByTestId("comment-thread").filter({ hasText: "tighten this" });
    await expect(thread).toHaveCount(1);
    const chip = thread.getByTestId("mention-chip");
    await expect(chip).toHaveAttribute("data-agent", "Copilot");
    await expect(chip).toHaveText("@Copilot");
    await expect(chip).toHaveAttribute("title", "Copilot (agent of @alice)");

    let result = await waiting;
    // The comment's activity row and the mention notification are written by separate watchers; the first wake may carry only one.
    let mention = result.events.find((e) => e.type === "mention");
    for (let i = 0; !mention && i < 3; i++) {
      result = await bot.events(docId, result.cursor, 2);
      mention = result.events.find((e) => e.type === "mention");
    }
    expect(Date.now() - posted).toBeLessThan(2000);
    expect(mention, JSON.stringify(result.events)).toMatchObject({ agent: "Copilot", snippet: "@alice/Copilot tighten this" });

    // Alice's own bell does not ring for a mention of her own agent.
    const bell = await page.request.get("/api/notifications?unread=1&kind=mention");
    expect(((await bell.json()) as { unreadCount: number }).unreadCount).toBe(0);
    await expect(page.getByTestId("comment-thread")).toHaveCount(2);
  });

  test("presence with an anchor draws the agent's caret in that paragraph; a suggestion moves it to the edit", async () => {
    const page = alice.page;
    const bot = agent(page, token);
    const paragraph = (text: string) => page.locator(".ProseMirror p").filter({ hasText: text });
    const caret = page.locator(".md-remote-caret[data-agent]");

    const placed = Date.now();
    const res = await bot.presence(docId, { state: "active", status: "reading", anchor: "Second paragraph" });
    expect(res.presence?.cursor).toBeTruthy();
    await expect(caret).toHaveCount(1, { timeout: Math.max(250, 1000 - (Date.now() - placed)) });
    await expect(paragraph("Second paragraph").locator(".md-remote-caret[data-agent]")).toHaveCount(1);
    await expect(caret.locator(".md-remote-caret-label")).toContainText("Copilot");
    await expect(caret.locator(".md-remote-caret-label svg")).toHaveCount(1);
    await expect(caret.locator(".md-remote-caret-label")).toHaveAttribute("title", "Follow Copilot (agent)");
    // The anchored range shows as the agent's selection.
    await expect(paragraph("Second paragraph").locator(".md-remote-selection")).toHaveCount(1);
    await page.screenshot({ path: "test-results/agent-caret.png" });

    const edited = Date.now();
    await bot.suggest(docId, [{ find: "First paragraph for the agent", replace: "Opening paragraph for the agent" }]);
    await expect(paragraph("for the agent to watch").locator(".md-remote-caret[data-agent]")).toHaveCount(1, { timeout: 3000 });
    expect(Date.now() - edited).toBeLessThan(3000);
    await expect(paragraph("Second paragraph").locator(".md-remote-caret[data-agent]")).toHaveCount(0);

    await bot.presence(docId, { state: "left" });
    await expect(caret).toHaveCount(0, { timeout: 3000 });
  });
});
