import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { AGENT_DOCS_URL } from "../src/lib/mcp";
import { codeText, createDocument, mintToken, openDocument, type MintedToken } from "./helpers";

/**
 * "Keep an agent here" (#1970, #981): the sentence that puts a person's agent into the watch loop for this
 * document lives in one dialog, reached from the presence popover, the command palette and the `/agent` slash
 * item. Agents are collaborators: the header has no agent pills, the presence stack is where they show up.
 */

const mod = process.platform === "darwin" ? "Meta" : "Control";
const PROMPT_RE = /^Sit in the Markdoc document "(.+)" \(id ([^)]+)\): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop\.$/;
const PILL_SELECTOR = '[data-testid="agent-pill"], [data-testid="agent-requests-pill"], [data-testid="agent-activity"]';

async function signInWithin(context: BrowserContext, login: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForLoadState("networkidle");
  return page;
}

/** Windows puts CRLF on the system clipboard for every LF written; fold it back before comparing. */
const readClipboard = async (page: Page) => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");

test.describe("keep an agent here", () => {
  let context: BrowserContext;
  let page: Page;
  let docId: string;
  let token: string;
  let minted: MintedToken | undefined;
  const title = "Keep-agent doc";

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1280, height: 800 } });
    page = await signInWithin(context, "keeper");
    minted = await mintToken(page, "Copilot CLI", { expiresInDays: 30 });
    token = minted.token;
    docId = await createDocument(page, "# Keep-agent doc\n\nA paragraph the agent could tighten.\n", title);
    await openDocument(page, docId);
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await context.close();
  });

  test("the header has no agent pills; the presence popover reaches the dialog in two clicks; the sentence names the document and Copy puts it on the clipboard", async () => {
    await expect(page.getByTestId("header").locator(PILL_SELECTOR)).toHaveCount(0);

    await page.getByTestId("presence").click(); // click 1
    const popover = page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    // No agent present, nothing waiting: no placeholder, no Requests section, the footer offers the action.
    await expect(page.getByTestId("presence-waiting")).toHaveCount(0);
    await expect(popover.getByTestId("presence-requests")).toHaveCount(0);
    const lead = popover.getByTestId("keep-agent-here");
    await expect(lead).toBeVisible();
    await expect(lead).toHaveText("Keep an agent here");
    await page.screenshot({ path: "test-results/keep-agent-here-popover.png", clip: { x: 0, y: 0, width: 1280, height: 420 } });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/keep-agent-here-popover.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } });
    await lead.click(); // click 2
    await expect(popover).toHaveCount(0);

    const dialog = page.getByTestId("keep-agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Keep an agent here" })).toBeVisible();
    const panel = dialog.getByTestId("keep-agent-panel");
    await expect(panel).toBeVisible();
    // The dialog carries the title; the panel does not repeat it (and has no back arrow).
    await expect(panel.getByRole("heading")).toHaveCount(0);
    await expect(panel.getByTestId("keep-agent-back")).toHaveCount(0);
    await expect(panel.getByTestId("keep-agent-clients")).toHaveText("Works with any MCP client: Copilot CLI, VS Code, Claude, Cursor.");
    const docsLink = panel.getByTestId("keep-agent-docs-link");
    await expect(docsLink).toBeVisible();
    await expect(docsLink).toHaveText("Agent docs · Sit in a document");
    await expect(docsLink).toHaveAttribute("href", `${AGENT_DOCS_URL}#sit-in-a-document`);
    await expect(docsLink).toHaveAttribute("target", "_blank");
    await expect(docsLink).toHaveAttribute("rel", "noreferrer");
    // The exact command, introduced by what to do with it.
    const hint = panel.getByTestId("keep-agent-hint");
    await expect(hint).toHaveText("Paste this into Copilot CLI (or any MCP client connected to Markdoc):");
    const prompt = panel.getByTestId("keep-agent-prompt");
    expect((await hint.boundingBox())!.y).toBeLessThan((await prompt.boundingBox())!.y);
    const text = (await prompt.innerText()).trim();
    const m = text.match(PROMPT_RE);
    expect(m, text).toBeTruthy();
    expect(m![1]).toBe(title);
    expect(m![2]).toBe(docId);
    expect(text).toContain("markdoc_presence");
    expect(text).toContain("markdoc_watch");
    await expect(panel.getByTestId("keep-agent-after")).toContainText("within a minute");
    // Has a token: no setup card in the way.
    await expect(dialog.getByTestId("agent-connect-card")).toHaveCount(0);
    await page.screenshot({ path: "test-results/keep-agent-here-dialog.png" });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/keep-agent-here-dialog.png` });

    await panel.getByTestId("keep-agent-copy").click();
    await expect(panel.getByTestId("keep-agent-copy")).toHaveText("Copied");
    expect(await readClipboard(page)).toBe(text);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the command palette lists it under 'agent' next to Comment (no separate ask entry) and opens the same dialog", async () => {
    await page.locator(".md-rich p").first().click();
    await page.keyboard.press(`${mod}+Shift+P`);
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await page.keyboard.type("agent");
    // #1075: the dialog and its palette command are gone; asking an agent is the Comment command.
    await expect(palette.locator('[data-testid^="palette-item-doc:ask"]')).toHaveCount(0);
    await expect(page.getByTestId("palette-item-block:comment")).toBeVisible();
    const item = page.getByTestId("palette-item-doc:keep-agent");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Keep an agent here");
    // One entry, not a second one mirrored from the slash menu.
    await expect(palette.getByRole("option").filter({ hasText: "Keep an agent here" })).toHaveCount(1);
    await item.click();
    await expect(palette).toHaveCount(0);
    const dialog = page.getByTestId("keep-agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("keep-agent-prompt")).toContainText(docId);
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

  test("typing /ag in the rich editor offers Comment then 'Keep an agent here'; ArrowDown + Enter opens the dialog and removes the typed text", async () => {
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".md-rich p").count()).toBe(2);
    await page.keyboard.type("/ag");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    // #1075: Comment took the `agent` keyword, so it is offered first; the Keep item is still one row away.
    await expect(menu.getByRole("option")).toHaveCount(2);
    await expect(page.getByTestId("slash-item-comment")).toHaveAttribute("aria-selected", "true");
    const item = page.getByTestId("slash-item-agent");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Keep an agent here");
    await expect(item).toContainText("Get the exact sentence that keeps an agent in this document");
    // The taller row is fully shown, not clipped by the menu's computed height.
    await expect(item.getByText("Get the exact sentence that keeps an agent in this document")).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("ArrowDown");
    await expect(item).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: "test-results/keep-agent-here-slash.png" });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/keep-agent-here-slash.png` });
    expect(await codeText(page)).toContain("/ag");

    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    const dialog = page.getByTestId("keep-agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("keep-agent-prompt")).toContainText(docId);
    await expect.poll(() => codeText(page)).not.toContain("/ag");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // `/ask` is Comment alone: the retired dialog has no slash item either.
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

  test("an agent's presence shows as a bot avatar within 5 s; its row carries the status; the footer still offers Keep an agent here only while no agent is present", async () => {
    const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
    const presence = async (state: "active" | "idle" | "left", status?: string) => {
      const res = await page.request.post(`/api/agent/documents/${docId}/presence`, { headers, data: { state, status } });
      expect(res.ok(), `presence -> ${res.status()} ${await res.text()}`).toBeTruthy();
    };
    const stack = page.getByTestId("presence");
    const agentAvatar = stack.locator('[data-testid="presence-avatar"][data-agent]');
    await expect(agentAvatar).toHaveCount(0);

    await presence("active", "watching");
    await expect(agentAvatar).toHaveCount(1, { timeout: 5_000 });
    await expect(stack).toHaveAttribute("aria-label", /Copilot CLI \(agent: watching\)/);
    // Still no pills anywhere in the header.
    await expect(page.getByTestId("header").locator(PILL_SELECTOR)).toHaveCount(0);

    await stack.click();
    const popover = page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    const row = popover.locator('[data-testid="presence-row"][data-agent]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Copilot CLI");
    await expect(row.getByTestId("presence-status")).toHaveText("watching");
    // An agent is here: the footer button is gone.
    await expect(popover.getByTestId("keep-agent-here")).toHaveCount(0);
    await page.screenshot({ path: "test-results/keep-agent-here-present.png", clip: { x: 0, y: 0, width: 1280, height: 420 } });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/keep-agent-here-present.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } });
    await page.keyboard.press("Escape");

    // Idle still counts as here.
    await presence("idle", "waiting for feedback");
    await expect(agentAvatar).toHaveCount(1);

    await presence("left");
    await expect(agentAvatar).toHaveCount(0, { timeout: 5_000 });
    await stack.click();
    await expect(popover.getByTestId("keep-agent-here")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});