import { test, expect, type Page } from "@playwright/test";
import { AGENT_DOCS_URL } from "../src/lib/mcp";
import { signIn, createDocument, openDocument, selectTextInRich, ensureCommentsOpen, mintToken, type MintedToken, type User } from "./helpers";

/** Pull the notifications store now instead of waiting for the 30 s poll. */
const refresh = (page: Page) =>
  page.evaluate(() => (window as unknown as { __markdocNotificationsRefresh?: () => Promise<void> }).__markdocNotificationsRefresh?.());

/** The three purple header pills that used to carry agent state; none may come back. */
const PILL_SELECTOR = '[data-testid="agent-pill"], [data-testid="agent-requests-pill"], [data-testid="agent-activity"]';

interface RequestDto {
  id: string;
  documentId: string;
  status: string;
  claimedBy: string | null;
  instruction: string;
  selection: { quote: string } | null;
  result: { suggestions: number; comments: number; summary?: string } | null;
}

/** Act as an agent: the same calls Copilot CLI makes through mcp/server.mjs, with a token minted in the UI. */
function agent(page: Page, token: string) {
  const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
  const call = async <T,>(method: "get" | "post", path: string, data?: unknown): Promise<T> => {
    const res = method === "get" ? await page.request.get(path, { headers }) : await page.request.post(path, { headers, data: data ?? {} });
    expect(res.ok(), `${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as T;
  };
  return {
    inbox: () => call<{ requests: RequestDto[]; agent: string }>("get", "/api/agent/requests?status=open"),
    claim: (docId: string, rid: string) => call<{ request: RequestDto }>("post", `/api/documents/${docId}/requests/${rid}/claim`),
    suggest: (docId: string, rid: string, edits: { find: string; replace: string }[]) => call<{ suggestions: number }>("post", `/api/documents/${docId}/suggest`, { edits, requestId: rid }),
    complete: (docId: string, rid: string, summary: string) => call<{ request: RequestDto }>("post", `/api/documents/${docId}/requests/${rid}/complete`, { summary }),
  };
}

test.describe("ask an agent", () => {
  let alice: User;
  let docId: string;
  let token: string;
  let minted: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    await alice.page.request.post("/api/notifications/read-all");
    minted = await mintToken(alice.page, "Copilot CLI", { expiresInDays: 30 });
    token = minted.token;
    docId = await createDocument(alice.page, "# Ask doc\n\nThe quick brown fox jumps over the lazy dog in the garden.\n\nA second paragraph to keep.\n", "Ask doc");
    await openDocument(alice.page, docId);
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice.context.close();
  });

  test("selection → Ask an agent → Tighten this → presence placeholder; the agent claims, suggests and completes → toast, suggestions, activity, bell", async () => {
    const page = alice.page;
    await selectTextInRich(page, "quick brown fox jumps over the lazy dog");
    await page.getByTestId("ask-agent-button").click();
    const dialog = page.getByTestId("ask-agent-dialog");
    await expect(dialog).toBeVisible();
    const docsLink = page.getByTestId("ask-agent-docs-link");
    await expect(docsLink).toBeVisible();
    await expect(docsLink).toHaveAttribute("href", AGENT_DOCS_URL);
    await expect(docsLink).toHaveAttribute("target", "_blank");
    await expect(docsLink).toHaveAttribute("rel", "noreferrer");
    // Alice has a token, so no setup card; the selection is echoed back.
    await expect(page.getByTestId("agent-connect-card")).toHaveCount(0);
    await expect(page.getByTestId("ask-agent-selection")).toContainText("quick brown fox");
    await expect(page.getByTestId("ask-agent-mode-rewrite")).toBeEnabled();
    await page.getByTestId("ask-agent-quick").filter({ hasText: "Tighten this" }).click();
    await expect(page.getByTestId("ask-agent-instruction")).toHaveValue("Tighten this");
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/ask-agent-dialog.png` });
    await page.getByTestId("ask-agent-send").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("toast").filter({ hasText: "Sent to agents" })).toBeVisible();

    // No header pill any more: the presence stack grows a dashed "waiting" placeholder while no agent is here,
    // and its popover lists the request with a Cancel button and the Keep-an-agent-here call to action.
    await expect(page.getByTestId("header").locator(PILL_SELECTOR)).toHaveCount(0);
    const stack = page.getByTestId("presence");
    const waiting = stack.getByTestId("presence-waiting");
    await expect(waiting).toBeVisible();
    await expect(waiting).toHaveAttribute("aria-label", "1 request waiting for an agent");
    await expect(waiting).toHaveAttribute("data-state", "waiting");
    await expect(stack).toHaveAttribute("aria-label", /; 1 request waiting for an agent$/);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/ask-agent-waiting.png` });
    await stack.click();
    const popover = page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    const requests = popover.getByTestId("presence-requests");
    await expect(requests.getByTestId("presence-request")).toHaveCount(1);
    await expect(requests.getByTestId("presence-request")).toHaveAttribute("data-status", "open");
    await expect(requests.getByTestId("presence-request")).toContainText("Tighten this");
    await expect(requests.getByTestId("presence-request-state")).toHaveText("Waiting for an agent · tracked changes · asked by you");
    await expect(requests.getByTestId("presence-request-cancel")).toBeVisible();
    await expect(popover.getByTestId("presence-waiting-note")).toContainText("1 request waiting for an agent");
    await expect(popover.getByTestId("keep-agent-here")).toBeVisible();
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/ask-agent-popover-requests.png` });
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);

    // The agent side.
    const bot = agent(page, token);
    const inbox = await bot.inbox();
    expect(inbox.agent).toBe("Copilot CLI");
    const mine = inbox.requests.find((r) => r.documentId === docId);
    expect(mine, JSON.stringify(inbox)).toBeTruthy();
    expect(mine!.instruction).toBe("Tighten this");
    expect(mine!.selection?.quote).toBe("quick brown fox jumps over the lazy dog");

    // Claiming over the API does not announce presence, so the placeholder stands in for the agent and shows it busy.
    await bot.claim(docId, mine!.id);
    await expect(waiting).toHaveAttribute("data-state", "working", { timeout: 2_000 });
    await expect(waiting).toHaveAttribute("aria-label", "Copilot CLI is working");
    await expect(waiting.getByTestId("presence-avatar-busy")).toBeVisible();
    await stack.click();
    await expect(requests.getByTestId("presence-request")).toHaveAttribute("data-status", "claimed");
    await expect(requests.getByTestId("presence-request-state")).toHaveText("Copilot CLI is on it · tracked changes · asked by you");
    await page.keyboard.press("Escape");
    // Its first write puts it in presence: the placeholder yields to the agent avatar, badge still on.
    const suggested = await bot.suggest(docId, mine!.id, [{ find: "jumps over the lazy dog in the garden", replace: "clears the dog" }]);
    expect(suggested.suggestions).toBeGreaterThan(0);
    const agentAvatar = stack.locator('[data-testid="presence-avatar"][data-agent]');
    await expect(agentAvatar).toHaveCount(1);
    await expect(waiting).toHaveCount(0);
    await expect(agentAvatar).toHaveAttribute("data-busy", "");
    await expect(agentAvatar.getByTestId("presence-avatar-busy")).toHaveAttribute("aria-label", "Copilot CLI is working");
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/ask-agent-working.png` });
    const done = await bot.complete(docId, mine!.id, "Shortened the sentence.");
    expect(done.request.status).toBe("done");
    expect(done.request.result?.suggestions).toBe(suggested.suggestions);

    // Human side: badge gone within 5 s, toast, Comments panel on Suggestions with the agent's proposals.
    await expect(stack.getByTestId("presence-avatar-busy")).toHaveCount(0, { timeout: 5_000 });
    await expect(agentAvatar).toHaveCount(1);
    await expect(page.getByTestId("toast").filter({ hasText: /Copilot CLI finished/ })).toBeVisible();
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    await expect(page.getByTestId("comments-tab-suggestions")).toContainText(String(suggested.suggestions));
    await expect(page.getByTestId("suggestion-card").first()).toContainText("Copilot CLI");

    // Activity has the ask and the completion.
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-activity").click();
    const rows = page.getByTestId("activity-row");
    await expect(rows.filter({ hasText: "asked an agent" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "finished a request" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "finished a request" })).toContainText("Shortened the sentence.");

    // Bell: request.done for the requester.
    await refresh(page);
    await page.getByTestId("notifications-bell").click();
    const item = page.getByTestId("notifications-popover").locator('[data-testid=notification-item][data-kind="request.done"]').first();
    await expect(item).toBeVisible();
    await expect(item).toContainText("finished your request");
    await page.keyboard.press("Escape");
  });

  test("cancel from the presence popover; the empty Comments panel offers Ask an agent", async () => {
    const page = alice.page;
    const fresh = await createDocument(page, "# Cancel doc\n\nNothing here yet.\n", "Cancel doc");
    await openDocument(page, fresh);
    await ensureCommentsOpen(page);
    const hint = page.getByTestId("comments-empty-ask-agent");
    await expect(hint).toContainText("Agents can review this document too");
    await page.getByTestId("comments-empty-ask-agent-button").click();
    await expect(page.getByTestId("ask-agent-dialog")).toBeVisible();
    await expect(page.getByTestId("ask-agent-selection")).toContainText("Whole document");
    await page.getByTestId("ask-agent-instruction").fill("Review the whole thing");
    await page.getByTestId("ask-agent-mode-comment").check();
    await page.getByTestId("ask-agent-send").click();
    const stack = page.getByTestId("presence");
    await expect(stack.getByTestId("presence-waiting")).toHaveAttribute("data-count", "1");
    await stack.click();
    const requests = page.getByTestId("presence-popover").getByTestId("presence-requests");
    await expect(requests.getByTestId("presence-request")).toHaveCount(1);
    await expect(requests.getByTestId("presence-request-state")).toHaveText("Waiting for an agent · comments · asked by you");
    await page.getByTestId("presence-request-cancel").click();
    await expect(requests).toHaveCount(0, { timeout: 1_000 });
    await expect(stack.getByTestId("presence-waiting")).toHaveCount(0);
    await expect(page.getByTestId("presence-popover").getByTestId("keep-agent-here")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => ((await (await page.request.get(`/api/documents/${fresh}/requests`)).json()) as { requests: RequestDto[] }).requests[0].status, { timeout: 5_000 })
      .toBe("cancelled");
  });

  test("first visit without a token shows the connect card with this origin; Create token goes to /settings#tokens", async ({ browser }) => {
    const dana = await signIn(browser, "dana-no-token");
    try {
      const page = dana.page;
      const id = await createDocument(page, "# Dana\n\nNo token yet.\n", "Dana");
      await openDocument(page, id);
      await page.getByTestId("ask-agent-button").click();
      const card = page.getByTestId("agent-connect-card");
      await expect(card).toBeVisible();
      const origin = await page.evaluate(() => window.location.origin);
      await expect(page.getByTestId("agent-connect-config")).toContainText(`"url": "${origin}/api/mcp"`);
      await expect(page.getByTestId("agent-connect-config")).toContainText('"type": "http"');
      await expect(page.getByTestId("agent-connect-config")).toContainText(["Bearer", "MARKDOC_TOKEN"].join(" "));
      // The stdio config is still there, one click away.
      await page.getByTestId("agent-connect-stdio-toggle").click();
      await expect(page.getByTestId("agent-connect-config-stdio")).toContainText(`"MARKDOC_URL": "${origin}"`);
      await expect(card).toContainText("Check Markdoc for requests");
      // The same "Stop the permission prompts" block as the Share card, with the allow line for the `markdoc` server key.
      await expect(card).toContainText("Stop the permission prompts");
      await expect(page.getByTestId("agent-connect-allow-line")).toContainText("copilot --allow-tool 'markdoc(markdoc_suggest)");

      // Dismiss is remembered.
      await page.getByTestId("agent-connect-dismiss").click();
      await expect(card).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.getByTestId("ask-agent-button").click();
      await expect(page.getByTestId("ask-agent-dialog")).toBeVisible();
      await expect(page.getByTestId("agent-connect-card")).toHaveCount(0);
      await page.keyboard.press("Escape");

      await page.evaluate(() => window.localStorage.removeItem("markdoc:agent-connect-dismissed"));
      await page.getByTestId("ask-agent-button").click();
      await expect(page.getByTestId("agent-connect-card")).toBeVisible();
      await page.getByTestId("agent-connect-create-token").click();
      await page.waitForURL((u) => u.pathname === "/settings");
      expect(new URL(page.url()).hash).toBe("#tokens");
      await expect(page.getByTestId("token-name")).toBeVisible();
      await expect(page.getByTestId("agent-connect-card")).toBeVisible();
      await expect(page.getByTestId("agent-connect-config")).toContainText(`"url": "${origin}/api/mcp"`);
      await expect(page.getByRole("tab", { name: "Copilot CLI" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tab", { name: "VS Code / other MCP clients" })).toBeVisible();
      await page.getByRole("tab", { name: "Copilot app" }).click();
      await expect(page.getByTestId("agent-connect-app-install")).toContainText("~/.copilot/extensions/markdoc");
      await expect(page.getByRole("link", { name: "Inside the Copilot app setup and limits" })).toHaveAttribute("href", /agents\.md#inside-the-copilot-app$/);
      await page.getByTestId("settings-back-to-document").click();
      await page.waitForURL((u) => u.pathname === `/d/${id}`);
    } finally {
      await dana.context.close();
    }
  });
});
