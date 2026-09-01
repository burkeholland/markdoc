import { test, expect, type Page } from "@playwright/test";
import { budgetMs, signIn, createDocument, openDocument, selectTextInRich, mintToken, type MintedToken, type User } from "./helpers";

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
  let busyDocId: string;
  let token: string;
  let minted: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    // "Copilot" is asserted on throughout (avatar label, @alice/Copilot, chips, toasts); review-suggestions.spec.ts
    // uses "Copilot Review" for the same user so the two files can share a run, even in parallel workers.
    minted = await mintToken(alice.page, "Copilot", { expiresInDays: 30 });
    token = minted.token;
    docId = await createDocument(alice.page, "# Presence doc\n\nFirst paragraph for the agent to watch.\n\nSecond paragraph.\n", "Presence doc");
    await openDocument(alice.page, docId);
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice.context.close();
  });

  test("an agent heartbeat shows a bot avatar with its status in the header; left removes it", async () => {
    const page = alice.page;
    const bot = agent(page, token);
    await expect(page.getByTestId("presence").getByTestId("presence-avatar")).toHaveCount(1);
    // Agents are collaborators: no agent pills in the header, ever.
    await expect(page.getByTestId("header").locator('[data-testid="agent-pill"], [data-testid="agent-requests-pill"], [data-testid="agent-activity"]')).toHaveCount(0);

    await bot.presence(docId, { state: "active", status: "drafting" });
    const avatar = page.getByTestId("presence").locator('[data-testid="presence-avatar"][data-agent]');
    await expect(avatar).toHaveCount(1, { timeout: 3000 });
    await expect(page.getByTestId("presence")).toHaveAttribute("aria-label", /Copilot \(agent: drafting\)/);
    // Present but not working on anything: no busy badge.
    await expect(page.getByTestId("presence-avatar-busy")).toHaveCount(0);

    await page.getByTestId("presence").click();
    const popover = page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    const row = popover.locator('[data-testid="presence-row"][data-agent]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Copilot");
    await expect(row).toContainText("Agent");
    await expect(row.getByTestId("presence-status")).toHaveText("drafting");
    await expect(row.getByTestId("presence-activity")).toHaveCount(0);
    // With an agent here, the popover does not offer "Keep an agent here".
    await expect(popover.getByTestId("keep-agent-here")).toHaveCount(0);
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
    expect(Date.now() - started).toBeLessThan(budgetMs(25_000));
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
    expect(Date.now() - posted).toBeLessThan(budgetMs(2000));
    expect(mention, JSON.stringify(result.events)).toMatchObject({ agent: "Copilot", snippet: "@alice/Copilot tighten this" });

    // Alice's own bell does not ring for a mention of her own agent (scoped to this document — other specs may leave alice unread mentions).
    const bell = await page.request.get("/api/notifications?unread=1&kind=mention");
    const { items } = (await bell.json()) as { items: { documentId: string; readAt: string | null }[] };
    expect(items.filter((n) => n.documentId === docId)).toHaveLength(0);
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
    await expect(paragraph("for the agent to watch").locator(".md-remote-caret[data-agent]")).toHaveCount(1, { timeout: budgetMs(3000) });
    expect(Date.now() - edited).toBeLessThan(budgetMs(3000));
    await expect(paragraph("Second paragraph").locator(".md-remote-caret[data-agent]")).toHaveCount(0);

    await bot.presence(docId, { state: "left" });
    await expect(caret).toHaveCount(0, { timeout: 3000 });
  });

  test("a request the agent is working on puts a busy badge on its avatar and a Requests row in the popover; completing clears both", async () => {
    const page = alice.page;
    const bot = agent(page, token);
    const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
    // A fresh document: the suggestion above left a 45 s `agentActivity` on the first one, which counts as working.
    busyDocId = await createDocument(page, "# Busy doc\n\nA paragraph to review.\n\nAnother one.\n", "Busy doc");
    await openDocument(page, busyDocId);
    await bot.presence(busyDocId, { state: "active", status: "watching" });
    const avatar = page.getByTestId("presence").locator('[data-testid="presence-avatar"][data-agent]');
    await expect(avatar).toHaveCount(1, { timeout: 3000 });
    const busy = page.getByTestId("presence").getByTestId("presence-avatar-busy");
    await expect(busy).toHaveCount(0);

    // Alice asks for comments on the whole document (same REST call the comment composer makes when a comment mentions an agent).
    const created = await page.request.post(`/api/documents/${busyDocId}/requests`, { data: { instruction: "Review the second paragraph", mode: "comment", selection: null } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const requestId = ((await created.json()) as { request: { id: string } }).request.id;
    // Waiting, agent present: no placeholder, no badge yet (nobody is working on it).
    await page.getByTestId("presence").click();
    const popover = page.getByTestId("presence-popover");
    const requests = popover.getByTestId("presence-requests");
    await expect(requests).toBeVisible();
    await expect(requests.getByTestId("presence-request")).toHaveCount(1);
    await expect(requests.getByTestId("presence-request")).toHaveAttribute("data-status", "open");
    await expect(requests.getByTestId("presence-request-state")).toContainText("Waiting for an agent · comments · asked by you");
    await expect(page.getByTestId("presence-waiting")).toHaveCount(0);
    await expect(busy).toHaveCount(0);

    const claim = await page.request.post(`/api/documents/${busyDocId}/requests/${requestId}/claim`, { headers });
    expect(claim.ok(), await claim.text()).toBeTruthy();
    // Within 2 s of the claim landing, the badge is on.
    await expect(busy).toHaveCount(1, { timeout: 2000 });
    await expect(busy).toHaveAttribute("aria-label", "Copilot is working");
    await expect(avatar).toHaveAttribute("data-busy", "");
    await expect(requests.getByTestId("presence-request")).toHaveAttribute("data-status", "claimed");
    await expect(requests.getByTestId("presence-request-state")).toContainText("Copilot is on it · comments");
    // The row shows the agent's own busy badge too.
    await expect(popover.locator('[data-testid="presence-row"][data-agent]').getByTestId("presence-avatar-busy")).toHaveCount(1);
    await page.screenshot({ path: "test-results/agent-presence-busy.png", clip: { x: 0, y: 0, width: 1280, height: 480 } });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/agent-presence-busy.png`, clip: { x: 0, y: 0, width: 1280, height: 480 } });

    const complete = await page.request.post(`/api/documents/${busyDocId}/requests/${requestId}/complete`, { headers, data: { summary: "Left one comment." } });
    expect(complete.ok(), await complete.text()).toBeTruthy();
    // Done: the Requests section is gone and, with no fresh activity, so is the badge — within 5 s.
    await expect(requests).toHaveCount(0, { timeout: 5000 });
    await expect(busy).toHaveCount(0, { timeout: 5000 });
    await expect(page.getByTestId("toast").filter({ hasText: /Copilot finished/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).not.toBeVisible();
    await bot.presence(busyDocId, { state: "left" });
    await expect(avatar).toHaveCount(0, { timeout: 3000 });
  });

  test("an agent edit sets agentActivity: the avatar is busy and the row appends the verb with its age", async () => {
    const page = alice.page;
    const bot = agent(page, token);
    await bot.presence(busyDocId, { state: "active", status: "reading" });
    const avatar = page.getByTestId("presence").locator('[data-testid="presence-avatar"][data-agent]');
    await expect(avatar).toHaveCount(1, { timeout: 3000 });
    const busy = page.getByTestId("presence").getByTestId("presence-avatar-busy");
    await expect(busy).toHaveCount(0);

    await bot.suggest(busyDocId, [{ find: "Another one.", replace: "Another one, revised." }]);
    await expect(busy).toHaveCount(1, { timeout: 3000 });
    await page.getByTestId("presence").click();
    const row = page.getByTestId("presence-popover").locator('[data-testid="presence-row"][data-agent]');
    const activity = row.getByTestId("presence-activity");
    await expect(activity).toBeVisible();
    await expect(activity).toHaveText(/^proposed changes · (just now|\d+ s ago)$/);
    // The row ticks: after the first seconds the wording moves on to a count.
    await expect(activity).toHaveText(/^proposed changes · \d+ s ago$/, { timeout: 12_000 });
    await expect(row.getByTestId("presence-section")).toContainText("proposed changes");
    await page.screenshot({ path: "test-results/agent-presence-activity.png", clip: { x: 0, y: 0, width: 1280, height: 480 } });
    await page.keyboard.press("Escape");
    await bot.presence(busyDocId, { state: "left" });
    await expect(avatar).toHaveCount(0, { timeout: 3000 });
  });
});
