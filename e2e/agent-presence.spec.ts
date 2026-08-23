import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, selectTextInRich, type User } from "./helpers";

interface EventsDto {
  cursor: string;
  events: { type: string; threadId?: string | null; author?: string; body?: string }[];
}

/** Act as an agent: the same REST calls Copilot CLI makes through mcp/server.mjs (markdoc_presence / markdoc_watch). */
function agent(page: Page, token: string) {
  const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
  return {
    presence: async (docId: string, body: { state: "active" | "idle" | "left"; status?: string }) => {
      const res = await page.request.post(`/api/agent/documents/${docId}/presence`, { headers, data: body });
      expect(res.ok(), `presence -> ${res.status()} ${await res.text()}`).toBeTruthy();
      return (await res.json()) as { presence: { name: string; status: string | null } | null };
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
});
