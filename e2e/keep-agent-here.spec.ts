import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createDocument, openDocument, selectTextInRich } from "./helpers";

/**
 * "Keep an agent here" (#1970): one click in the editor gives the person the sentence that puts their agent into
 * the watch loop for this document, and the header's agent pill says when one is actually sitting there.
 */

const mod = process.platform === "darwin" ? "Meta" : "Control";
const PROMPT_RE = /^Sit in the Markdoc document "(.+)" \(id ([^)]+)\): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop\.$/;

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
  const title = "Keep-agent doc";

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1280, height: 800 } });
    page = await signInWithin(context, "keeper");
    const res = await page.request.post("/api/tokens", { data: { name: "Copilot CLI", expiresInDays: 30 } });
    expect(res.ok()).toBeTruthy();
    token = ((await res.json()) as { token: { token: string } }).token.token;
    docId = await createDocument(page, "# Keep-agent doc\n\nA paragraph the agent could tighten.\n", title);
    await openDocument(page, docId);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("the header pill reaches 'Keep an agent here' in two clicks; the sentence names the document and Copy puts it on the clipboard", async () => {
    const pill = page.getByTestId("agent-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText("No agent here");

    await pill.click(); // click 1
    const popover = page.getByTestId("agent-pill-popover");
    await expect(popover).toBeVisible();
    // With no agent present, the menu leads with the action.
    const lead = popover.getByTestId("keep-agent-here");
    await expect(lead).toBeVisible();
    await lead.click(); // click 2

    const panel = popover.getByTestId("keep-agent-panel");
    await expect(panel).toBeVisible();
    const prompt = popover.getByTestId("keep-agent-prompt");
    const text = (await prompt.innerText()).trim();
    const m = text.match(PROMPT_RE);
    expect(m, text).toBeTruthy();
    expect(m![1]).toBe(title);
    expect(m![2]).toBe(docId);
    expect(text).toContain("markdoc_presence");
    expect(text).toContain("markdoc_watch");
    await expect(popover.getByTestId("keep-agent-hint")).toContainText("Paste this into Copilot CLI");
    // Has a token: no setup card in the way.
    await expect(popover.getByTestId("agent-connect-card")).toHaveCount(0);
    await page.screenshot({ path: "test-results/keep-agent-here-popover.png" });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/keep-agent-here-popover.png` });

    await popover.getByTestId("keep-agent-copy").click();
    await expect(popover.getByTestId("keep-agent-copy")).toHaveText("Copied");
    expect(await readClipboard(page)).toBe(text);

    // Back returns to the agent list; Escape closes.
    await popover.getByTestId("keep-agent-back").click();
    await expect(popover.getByTestId("keep-agent-here")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  test("the Ask-an-agent dialog footer opens the same popover", async () => {
    await selectTextInRich(page, "agent could tighten");
    await page.getByTestId("ask-agent-button").click();
    await expect(page.getByTestId("ask-agent-dialog")).toBeVisible();
    await page.getByTestId("ask-agent-keep").click();
    const popover = page.getByTestId("keep-agent-popover");
    await expect(popover).toBeVisible();
    const text = (await popover.getByTestId("keep-agent-prompt").innerText()).trim();
    expect(text).toContain(`"${title}" (id ${docId})`);
    expect(text).toContain("markdoc_presence");
    expect(text).toContain("markdoc_watch");
    await popover.getByTestId("keep-agent-copy").click();
    expect(await readClipboard(page)).toBe(text);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    // The dialog itself is still open; Escape again closes it.
    await expect(page.getByTestId("ask-agent-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ask-agent-dialog")).toHaveCount(0);
  });

  test("the command palette lists it under 'agent' and opens the pill on that view", async () => {
    await page.locator(".md-rich p").first().click();
    await page.keyboard.press(`${mod}+Shift+P`);
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await page.keyboard.type("agent");
    await expect(page.getByTestId("palette-item-doc:ask-agent")).toBeVisible();
    const item = page.getByTestId("palette-item-doc:keep-agent");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Keep an agent here");
    await item.click();
    await expect(palette).toHaveCount(0);
    const popover = page.getByTestId("agent-pill-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("keep-agent-prompt")).toContainText(docId);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  test("an agent's presence flips the pill to '<Agent> is here' within 5 s and back when it leaves", async () => {
    const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
    const presence = async (state: "active" | "idle" | "left", status?: string) => {
      const res = await page.request.post(`/api/agent/documents/${docId}/presence`, { headers, data: { state, status } });
      expect(res.ok(), `presence -> ${res.status()} ${await res.text()}`).toBeTruthy();
    };
    const pill = page.getByTestId("agent-pill");
    await expect(pill).toContainText("No agent here");

    await presence("active", "watching");
    await expect(pill).toContainText("is here", { timeout: 5_000 });
    await expect(pill).toContainText("Copilot CLI is here");
    await expect(pill).toHaveAttribute("data-present", "1");

    // The menu lists the agent (with its status) and still offers Keep an agent here, after the list.
    await pill.click();
    const popover = page.getByTestId("agent-pill-popover");
    await expect(popover).toBeVisible();
    const item = popover.getByTestId("agent-pill-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("Copilot CLI");
    await expect(item).toContainText("watching");
    await expect(popover.getByTestId("keep-agent-here")).toBeVisible();
    await page.screenshot({ path: "test-results/keep-agent-here-present.png", clip: { x: 0, y: 0, width: 1280, height: 420 } });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/keep-agent-here-present.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } });
    await page.keyboard.press("Escape");

    // Idle still counts as here.
    await presence("idle", "waiting for feedback");
    await expect(pill).toContainText("Copilot CLI is here");

    await presence("left");
    await expect(pill).toContainText("No agent here", { timeout: 5_000 });
    await expect(pill).toHaveAttribute("data-present", "0");
  });
});
