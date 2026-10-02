import { test, expect } from "./fixtures";
import type { BrowserContext, Page } from "@playwright/test";
import { AGENT_DOCS_URL } from "../src/lib/mcp";
import { codeText, createDocument, devLogin, mintToken, openDocument, uniqueLogin, type MintedToken } from "./helpers";

// One-time keys are created here; keep them out of traces, screenshots and failure snapshots.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * "Connect an AI agent" (#1970, #981): the steps that set an agent up and then hand it this document live in one
 * dialog, reached from the people popover, Share, the command palette, the `/agent` slash item and the hint bar.
 * Agents are collaborators: the header has no agent pills, the presence stack is where they show up.
 */

const mod = process.platform === "darwin" ? "Meta" : "Control";
const PROMPT_RE = /^Sit in the Markdoc document "(.+)" \(id ([^)]+)\): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop\.$/;
const PILL_SELECTOR = '[data-testid="agent-pill"], [data-testid="agent-requests-pill"], [data-testid="agent-activity"]';
const bearer = (key: string) => ["Bearer", key].join(" ");

async function signInWithin(context: BrowserContext, login: string): Promise<Page> {
  const page = await context.newPage();
  await devLogin(page, login);
  await page.waitForLoadState("networkidle");
  return page;
}

/** Windows puts CRLF on the system clipboard for every LF written; fold it back before comparing. */
const readClipboard = async (page: Page) => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");

test.describe("connect an AI agent", () => {
  // Test 2 uses the key test 1 made: a failure upstream skips the rest.
  test.describe.configure({ mode: "serial" });
  let context: BrowserContext;
  let page: Page;
  let docId: string;
  let key = "";
  let minted: MintedToken | undefined;
  const title = "Connect-agent doc";

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1280, height: 800 } });
    // Per run: the tests make keys, and a fixed login would carry them into the next run.
    page = await signInWithin(context, uniqueLogin("connector"));
    docId = await createDocument(page, "# Connect-agent doc\n\nA paragraph the agent could tighten.\n", title);
    await openDocument(page, docId);
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await context.close();
  });

  test("the people popover reaches the steps in two clicks; a key and the sentence for the agent are one click and one paste away", async () => {
    await expect(page.getByTestId("header").locator(PILL_SELECTOR)).toHaveCount(0);

    await page.getByTestId("presence").click(); // click 1
    const popover = page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    // No agent present, nothing waiting: no placeholder, no Requests section, the footer offers the action.
    await expect(page.getByTestId("presence-waiting")).toHaveCount(0);
    await expect(popover.getByTestId("presence-requests")).toHaveCount(0);
    const lead = popover.getByTestId("connect-agent");
    await expect(lead).toBeVisible();
    await expect(lead).toHaveText("Connect an AI agent");
    await lead.click(); // click 2
    await expect(popover).toHaveCount(0);

    const dialog = page.getByTestId("agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Connect an AI agent" })).toBeVisible();
    const setup = dialog.getByTestId("agent-setup");
    await expect(setup).toHaveAttribute("data-state", "new");
    await expect(setup.getByRole("heading", { level: 3 })).toHaveText(["Add Markdoc to your agent", `Ask your agent to join “${title}”`]);
    const docsLink = setup.getByTestId("agent-docs-link");
    await expect(docsLink).toBeVisible();
    await expect(docsLink).toHaveAttribute("href", AGENT_DOCS_URL);
    await expect(docsLink).toHaveAttribute("target", "_blank");
    await expect(docsLink).toHaveAttribute("rel", "noreferrer");
    const opening = await dialog.evaluate((el) => {
      const box = el.closest('[role="dialog"]')!;
      return { height: box.getBoundingClientRect().height, scrollHeight: box.scrollHeight };
    });
    expect(opening.scrollHeight, "the first screen fits at 1280x800").toBeLessThanOrEqual(opening.height + 1);

    await setup.getByTestId("agent-create-key").click();
    const command = (await setup.getByTestId("agent-setup-snippet").innerText()).trim();
    key = command.match(/mdk_[\w-]+/)?.[0] ?? "";
    expect(key).not.toBe("");

    // The sentence for the agent: introduced by what to do with it, then the exact words, naming this document.
    const prompt = setup.getByTestId("agent-invite-prompt");
    const text = (await prompt.innerText()).trim();
    const m = text.match(PROMPT_RE);
    expect(m, text).toBeTruthy();
    expect(m![1]).toBe(title);
    expect(m![2]).toBe(docId);
    const hint = setup.getByText("Paste this into your agent.", { exact: false }).first();
    expect((await hint.boundingBox())!.y).toBeLessThan((await prompt.boundingBox())!.y);
    await setup.getByTestId("agent-invite-copy").click();
    await expect(setup.getByTestId("agent-invite-copy")).toHaveText("Copied");
    expect(await readClipboard(page)).toBe(text);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("once an agent has used the key, the dialog opens on the invite, with Connect another agent and Manage keys", async () => {
    const listed = await page.request.post("/api/mcp", {
      headers: { Authorization: bearer(key), Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(listed.ok()).toBeTruthy();

    await page.getByTestId("presence").click();
    await page.getByTestId("presence-popover").getByTestId("connect-agent").click();
    const dialog = page.getByTestId("agent-dialog");
    const returning = dialog.getByTestId("agent-connected");
    await expect(returning).toBeVisible();
    await expect(dialog.getByTestId("agent-setup")).toHaveCount(0);
    await expect(returning.getByTestId("agent-connected-banner")).toContainText("AI agent is connected");
    await expect(returning.getByTestId("agent-invite")).toContainText(`Ask your agent to join “${title}”`);
    const text = (await returning.getByTestId("agent-invite-prompt").innerText()).trim();
    expect(text.match(PROMPT_RE)?.[2]).toBe(docId);
    const settings = `/settings?next=${encodeURIComponent(`/d/${docId}`)}#tokens`;
    await expect(returning.getByTestId("agent-manage-keys")).toHaveAttribute("href", settings);
    const box = await dialog.evaluate((el) => {
      const shell = el.closest('[role="dialog"]')!;
      return { height: shell.getBoundingClientRect().height, scrollHeight: shell.scrollHeight };
    });
    expect(box.scrollHeight, "the invite fits at 1280x800").toBeLessThanOrEqual(box.height + 1);

    await returning.getByTestId("agent-invite-copy").click();
    await expect(returning.getByTestId("agent-invite-copy")).toHaveText("Copied");
    expect(await readClipboard(page)).toBe(text);

    // Another agent: back to the steps, with the key of the one already connected nowhere on the page.
    await returning.getByTestId("agent-connect-another").click();
    await expect(dialog.getByTestId("agent-setup")).toHaveAttribute("data-state", "new");
    expect(await page.locator("body").innerText()).not.toContain(key);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("typing /ag in the rich editor offers Comment then 'Connect an AI agent'; ArrowDown + Enter opens the dialog and removes the typed text", async () => {
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".md-rich p").count()).toBe(2);
    await page.keyboard.type("/ag");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    // #1075: Comment took the `agent` keyword, so it is offered first; the connect item is one row away.
    await expect(menu.getByRole("option")).toHaveCount(2);
    await expect(page.getByTestId("slash-item-comment")).toHaveAttribute("aria-selected", "true");
    const item = page.getByTestId("slash-item-agent");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Connect an AI agent");
    await expect(item).toContainText("Set up Copilot, Claude or Cursor, or invite your agent here");
    // The taller row is fully shown, not clipped by the menu's computed height.
    await expect(item.getByText("Set up Copilot, Claude or Cursor, or invite your agent here")).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("ArrowDown");
    await expect(item).toHaveAttribute("aria-selected", "true");
    expect(await codeText(page)).toContain("/ag");

    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    const dialog = page.getByTestId("agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("agent-invite-prompt")).toContainText(docId);
    await expect.poll(() => codeText(page)).not.toContain("/ag");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // `/ask` is Comment alone: there is no separate ask item.
    await page.keyboard.type("/ask");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveCount(1);
    await expect(page.getByTestId("slash-item-comment")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).not.toContain("/ask");
    // Clean the empty paragraph up so the presence test below sees the original document.
    await page.keyboard.press("Backspace");
  });

  test("an agent's presence shows as a bot avatar within 5 s; its row carries the status; the footer offers Connect an AI agent only while no agent is present", async () => {
    minted = await mintToken(page, "Presence bot", { expiresInDays: 1 });
    const headers = { Authorization: bearer(minted.token), "Content-Type": "application/json" };
    const presence = async (state: "active" | "idle" | "left", status?: string) => {
      const res = await page.request.post(`/api/agent/documents/${docId}/presence`, { headers, data: { state, status } });
      expect(res.ok(), `presence -> ${res.status()} ${await res.text()}`).toBeTruthy();
    };
    const stack = page.getByTestId("presence");
    const agentAvatar = stack.locator('[data-testid="presence-avatar"][data-agent]');
    await expect(agentAvatar).toHaveCount(0);

    await presence("active", "watching");
    await expect(agentAvatar).toHaveCount(1, { timeout: 5_000 });
    await expect(stack).toHaveAttribute("aria-label", /Presence bot \(agent: watching\)/);
    // Still no pills anywhere in the header.
    await expect(page.getByTestId("header").locator(PILL_SELECTOR)).toHaveCount(0);

    await stack.click();
    const popover = page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    const row = popover.locator('[data-testid="presence-row"][data-agent]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Presence bot");
    await expect(row.getByTestId("presence-status")).toHaveText("watching");
    // An agent is here: the footer button is gone.
    await expect(popover.getByTestId("connect-agent")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Idle still counts as here.
    await presence("idle", "waiting for feedback");
    await expect(agentAvatar).toHaveCount(1);

    await presence("left");
    await expect(agentAvatar).toHaveCount(0, { timeout: 5_000 });
    await stack.click();
    await expect(popover.getByTestId("connect-agent")).toBeVisible();
    await page.keyboard.press("Escape");
  });
  test("the command palette lists it under 'agent' next to Comment (no separate ask entry) and opens the same dialog", async () => {
    await page.locator(".md-rich p").first().click();
    await page.keyboard.press(`${mod}+Shift+P`);
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await page.keyboard.type("agent");
    // #1075: asking an agent is the Comment command, not a dialog of its own.
    await expect(palette.locator('[data-testid^="palette-item-doc:ask"]')).toHaveCount(0);
    await expect(page.getByTestId("palette-item-block:comment")).toBeVisible();
    const item = page.getByTestId("palette-item-doc:connect-agent");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Connect an AI agent");
    // One entry, not a second one mirrored from the slash menu.
    await expect(palette.getByRole("option").filter({ hasText: "Connect an AI agent" })).toHaveCount(1);
    await item.click();
    await expect(palette).toHaveCount(0);
    const dialog = page.getByTestId("agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("agent-invite-prompt")).toContainText(docId);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // "ask an agent" in the palette lands on Comment, first.
    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(palette).toBeVisible();
    await page.keyboard.type("ask an agent");
    await expect(palette.getByRole("option").first()).toHaveAttribute("data-testid", "palette-item-block:comment");
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  });
});
