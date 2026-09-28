import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { AGENT_DOCS_URL } from "../src/lib/mcp";
import { createDocument, devLogin, openDocument, uniqueLogin } from "./helpers";

// One-time keys are exercised here, but must never appear in captured artifacts.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off", video: "off" });

/** The dialog is capped at 100dvh - 2rem: 768 px at 1280x800. */
const DIALOG_CAP = 768;

const bearer = (key: string) => ["Bearer", key].join(" ");
const keyIn = (command: string) => command.match(/mdk_[\w-]+/)?.[0] ?? "";
const readBlock = async (block: Locator) => (await block.innerText()).trim();

/** The Share dialog's "Connect an AI agent" row hands off to the steps: Share closes first, so only one dialog is ever open. */
async function openConnectFromShare(page: Page) {
  await page.getByTestId("share-button").click();
  await expect(page.getByRole("dialog", { name: /share/i })).toBeVisible();
  await page.getByTestId("share-connect-agent").click();
  const dialog = page.getByRole("dialog", { name: "Connect an AI agent" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  return { dialog, setup: dialog.getByTestId("agent-setup") };
}

const postsToTokens = (page: Page) => page.waitForRequest((req) => req.url().endsWith("/api/tokens") && req.method() === "POST");

/**
 * The Share dialog is people, link, and one row that leads to the agent steps. The steps themselves (pick an agent,
 * make a key, paste one command) are src/components/agents; the endpoint is covered by src/app/api/mcp/route.test.ts
 * and scripts/mcp-smoke.mjs. Here: how it lays out, and that what it hands out really works.
 */
test.describe("share dialog", () => {
  test("reads top to bottom (add people, who has access, the link, connect an agent, Done) and fits without scrolling", async ({ browser }) => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const login = uniqueLogin("share-owner");
    await devLogin(page, login);
    const id = await createDocument(page, "# Share layout\n\nHello.\n", "Share layout");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);

    await page.getByTestId("share-button").click();
    const dialog = page.getByRole("dialog", { name: /share/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("owner-row")).toContainText(`@${login}`);
    await expect(page.getByText("Nobody else has been added yet.")).toBeVisible();

    const size = await dialog.evaluate((el) => ({ height: el.getBoundingClientRect().height, scrollHeight: el.scrollHeight }));
    console.log(`share dialog @1280x800: height ${size.height} px, scrollHeight ${size.scrollHeight} px, cap ${DIALOG_CAP} px`);
    expect(size.height).toBeLessThanOrEqual(DIALOG_CAP - 100);
    expect(size.scrollHeight).toBeLessThanOrEqual(size.height + 1);

    const top = (testId: string) => page.getByTestId(testId).evaluate((el) => el.getBoundingClientRect().top);
    const order = ["share-login", "owner-row", "link-access", "editor-link", "share-connect-agent", "share-footer"];
    const tops: number[] = [];
    for (const testId of order) tops.push(await top(testId));
    for (let i = 1; i < tops.length; i++) expect(tops[i], `${order[i]} sits below ${order[i - 1]}`).toBeGreaterThan(tops[i - 1]);
    const footerButtons = page.getByTestId("share-footer").getByRole("button");
    await expect(footerButtons).toHaveCount(1);
    await expect(footerButtons).toHaveText("Done");
    await expect(page.getByTestId("share-connect-agent")).toContainText("Connect an AI agent");

    // Restricted by default: one link. Copy puts exactly that URL on the clipboard.
    await expect(page.getByTestId("link-access")).toHaveValue("private");
    await expect(page.getByTestId("reader-link")).toHaveCount(0);
    await expect(page.getByTestId("editor-link")).toContainText(`/d/${id}`);
    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("copy-link")).toHaveText("Copied", { timeout: 1_000 });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/d/${id}`);

    // Opening the link up adds the reader page, with its own Copy; closing it again takes it away.
    await page.getByTestId("link-access").selectOption("view");
    await expect(page.getByTestId("reader-link")).toContainText(`/p/${id}`);
    await page.getByTestId("copy-reader-link").click();
    await expect(page.getByTestId("copy-reader-link")).toHaveText("Copied", { timeout: 1_000 });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/p/${id}`);
    await page.getByTestId("link-access").selectOption("private");
    await expect(page.getByTestId("reader-link")).toHaveCount(0);

    await footerButtons.click();
    await expect(dialog).toHaveCount(0);
    await context.close();
  });

  test("Connect an AI agent closes Share, opens the steps, and one click makes a key that works against /api/mcp", async ({ browser }) => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("share-agent-owner"));
    const id = await createDocument(page, "# Agent share\n\nHello agent.\n", "Agent share");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);

    const { dialog, setup } = await openConnectFromShare(page);
    await expect(page.getByRole("dialog", { name: /share/i })).toHaveCount(0);
    // A new account starts at the beginning: Copilot CLI picked, sensible defaults, and nothing secret on the page yet.
    await expect(setup).toHaveAttribute("data-state", "new");
    await expect(setup.getByRole("radio", { name: "Copilot CLI" })).toBeChecked();
    await expect(setup.getByTestId("agent-key-summary")).toHaveText("Comment & suggest · all your documents · expires in 90 days");
    await expect(setup.getByTestId("agent-setup-snippet")).toHaveCount(0);
    await expect(setup).toContainText("Once your agent is connected, you get a sentence to paste into it.");
    await expect(setup.getByTestId("agent-docs-link")).toHaveAttribute("href", AGENT_DOCS_URL);
    const opening = await dialog.evaluate((el) => ({ height: el.getBoundingClientRect().height, scrollHeight: el.scrollHeight }));
    expect(opening.scrollHeight).toBeLessThanOrEqual(opening.height + 1);

    // One click makes the key, with the defaults.
    const [request] = await Promise.all([postsToTokens(page), setup.getByTestId("agent-create-key").click()]);
    expect(request.postDataJSON()).toEqual({ name: "Copilot CLI", expiresInDays: 90, scope: "comment", documentIds: null });
    await expect(setup).toHaveAttribute("data-state", "waiting");
    const snippet = setup.getByTestId("agent-setup-snippet");
    await expect(snippet).toBeVisible();
    const command = await readBlock(snippet);
    const key = keyIn(command);
    expect(key, "the command carries the new key").not.toBe("");
    expect(command).toBe(`copilot mcp add --transport http --header "Authorization: ${bearer(key)}" markdoc ${origin}/api/mcp`);
    await expect(setup).toContainText("It is shown only once");
    await expect(setup.getByTestId("agent-connection")).toHaveAttribute("data-state", "waiting");
    // Step 3 has come alive: the sentence names this document.
    await expect(setup.getByTestId("agent-invite-prompt")).toContainText(`(id ${id})`);
    // Copy is already focused, and puts exactly the command on the clipboard.
    await expect(setup.getByTestId("agent-setup-copy")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(setup.getByTestId("agent-setup-copy")).toHaveText("Copied");
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(command);

    // "Skip permission prompts" lists only the tools a comment-scoped key can run.
    await setup.getByText("Skip permission prompts", { exact: true }).click();
    const allowLine = setup.locator("details", { hasText: "Skip permission prompts" }).locator("pre");
    expect(await readBlock(allowLine)).toBe("copilot --allow-tool 'markdoc(markdoc_suggest),markdoc(markdoc_comment),markdoc(markdoc_presence)'");

    // The URL in the command is live, and the key in it works.
    const alive = await page.request.get(`${origin}/api/mcp`);
    expect(alive.ok()).toBeTruthy();
    const info = (await alive.json()) as { name: string; tools: number };
    expect(info.name).toBe("markdoc");
    expect(info.tools).toBeGreaterThan(0);
    const listed = await page.request.post(`${origin}/api/mcp`, {
      headers: { Authorization: bearer(key), Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(listed.ok()).toBeTruthy();
    const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toContain("markdoc_read_document");
    expect(tools.length).toBe(info.tools);

    // The dialog notices (it looks every few seconds): the command has done its job, so it and the key leave the screen.
    await expect(setup).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
    await expect(dialog.getByTestId("agent-connected-banner")).toContainText("Copilot CLI is connected");
    await expect(dialog.getByTestId("agent-invite-prompt")).toContainText(`(id ${id})`);
    await expect(dialog.getByTestId("agent-setup-snippet")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain(key);

    // The default is really comment-scoped and covers every document: reading works, rewriting is a 403 that says what to do.
    const auth = { Authorization: bearer(key), "Content-Type": "application/json" };
    expect((await page.request.get(`${origin}/api/documents/${id}/content`, { headers: auth })).status()).toBe(200);
    const refused = await page.request.put(`${origin}/api/documents/${id}/content`, { headers: auth, data: { content: "# Rewritten\n" } });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("This token is comment-scoped; create a full-access token at /settings to rewrite documents");
    const who = (await (await page.request.get(`${origin}/api/me`, { headers: auth })).json()) as { scope: string; documentIds: string[] | null };
    expect(who).toMatchObject({ scope: "comment", documentIds: null });
    await context.close();
  });

  test("the command follows the agent you pick: one key, six formats, and the pick is remembered", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("share-agent-picker"));
    const id = await createDocument(page, "# Picker\n\nHello.\n", "Picker");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);
    const url = `${origin}/api/mcp`;
    let creates = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/api/tokens") && req.method() === "POST") creates++;
    });

    const { dialog, setup } = await openConnectFromShare(page);
    const picker = setup.getByRole("radiogroup", { name: "Agent" });
    await expect(picker.getByRole("radio")).toHaveCount(6);
    await setup.getByTestId("agent-create-key").click();
    const snippet = setup.getByTestId("agent-setup-snippet");
    await expect(snippet).toBeVisible();
    const key = keyIn(await readBlock(snippet));
    expect(key).not.toBe("");
    const authorization = bearer(key);

    await picker.getByText("Claude Code", { exact: true }).click();
    await expect(setup.getByRole("heading", { name: "Add Markdoc to Claude Code" })).toBeVisible();
    expect(await readBlock(snippet)).toBe(`claude mcp add --transport http --scope user markdoc ${url} --header "Authorization: ${authorization}"`);

    await picker.getByText("Cursor", { exact: true }).click();
    expect(JSON.parse(await readBlock(snippet))).toEqual({ mcpServers: { markdoc: { url, headers: { Authorization: authorization } } } });

    await picker.getByText("VS Code", { exact: true }).click();
    expect(JSON.parse(await readBlock(snippet))).toEqual({ servers: { markdoc: { type: "http", url, headers: { Authorization: authorization } } } });
    await expect(setup).toContainText("MCP: Open User Configuration");

    await picker.getByText("Other", { exact: true }).click();
    expect(JSON.parse(await readBlock(snippet))).toEqual({ mcpServers: { markdoc: { type: "http", url, headers: { Authorization: authorization }, tools: ["*"] } } });
    await setup.getByText("No HTTP support?", { exact: true }).click();
    const stdio = JSON.parse(await readBlock(setup.locator("details", { hasText: "No HTTP support?" }).locator("pre"))) as { mcpServers: { markdoc: { env: Record<string, string> } } };
    expect(stdio.mcpServers.markdoc.env).toEqual({ MARKDOC_URL: origin, MARKDOC_TOKEN: key });

    await picker.getByText("Copilot app", { exact: true }).click();
    expect(await readBlock(snippet)).toBe(`MARKDOC_URL=${origin}\nMARKDOC_TOKEN=${key}`);
    await expect(setup.getByText("Install the extension", { exact: true })).toBeVisible();
    await expect(setup.getByTestId("agent-client-docs-link")).toHaveAttribute("href", `${AGENT_DOCS_URL}#inside-the-copilot-app`);

    // Six formats, one key.
    expect(creates).toBe(1);

    // The pick is remembered the next time the steps open.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const again = await openConnectFromShare(page);
    await expect(again.setup.getByRole("radio", { name: "Copilot app" })).toBeChecked();
    await context.close();
  });

  test("Change opens the options: a Read key for this document only cannot comment or see other documents, and a taken name is refused", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("share-agent-reader"));
    const id = await createDocument(page, "# Read only\n\nHello agent.\n", "Read only");
    const other = await createDocument(page, "# Other\n\nNot for the bot.\n", "Other");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);

    const { dialog, setup } = await openConnectFromShare(page);
    const toggle = setup.getByTestId("agent-options-toggle");
    await expect(toggle).toHaveText("Change");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveText("Hide options");
    const options = setup.getByTestId("agent-options");
    await expect(options.getByRole("radio")).toHaveCount(3);
    await expect(options.getByTestId("agent-scope-comment")).toBeChecked();
    await expect(options.getByTestId("agent-only-doc")).not.toBeChecked();
    await options.getByTestId("agent-scope-read").check();
    await options.getByTestId("agent-only-doc").check();
    await options.getByTestId("agent-key-name").fill("Read bot");
    await expect(setup.getByTestId("agent-key-summary")).toHaveText("Read only · this document only · expires in 90 days");
    const [request] = await Promise.all([postsToTokens(page), setup.getByTestId("agent-create-key").click()]);
    expect(request.postDataJSON()).toEqual({ name: "Read bot", expiresInDays: 90, scope: "read", documentIds: [id] });
    const key = keyIn(await readBlock(setup.getByTestId("agent-setup-snippet")));
    expect(key).not.toBe("");

    const ro = { Authorization: bearer(key), "Content-Type": "application/json" };
    expect((await page.request.get(`${origin}/api/documents/${id}/content`, { headers: ro })).status()).toBe(200);
    const noComment = await page.request.post(`${origin}/api/documents/${id}/comments`, { headers: ro, data: { action: "add", quote: "Hello agent.", body: "nope" } });
    expect(noComment.status()).toBe(403);
    expect(((await noComment.json()) as { error: string }).error).toContain("read-scoped");
    expect((await page.request.get(`${origin}/api/documents/${other}/content`, { headers: ro })).status()).toBe(404);

    // The key has just been used, so reopening shows the invite; "Connect another agent" goes back to the steps.
    // Names are matched by their @mention: a second "Read bot" is refused on this screen's own terms, and what was typed stays.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const again = await openConnectFromShare(page);
    await expect(again.dialog.getByTestId("agent-connected-banner")).toContainText("Read bot is connected");
    await again.dialog.getByTestId("agent-connect-another").click();
    await expect(again.setup).toHaveAttribute("data-state", "new");
    await again.setup.getByTestId("agent-options-toggle").click();
    await again.setup.getByTestId("agent-key-name").fill("read-bot");
    await again.setup.getByTestId("agent-create-key").click();
    const error = again.setup.getByTestId("agent-error");
    await expect(error).toHaveText("Another key already has that name. Choose a different one.");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(again.setup.getByTestId("agent-key-name")).toHaveValue("read-bot");
    await expect(again.setup.getByTestId("agent-create-key")).toBeEnabled();
    await context.close();
  });

  test("Full access for this document that never expires: the key can rewrite it, and only it", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("share-agent-scoper"));
    const id = await createDocument(page, "# Scoped share\n\nHello agent.\n", "Scoped share");
    const other = await createDocument(page, "# Elsewhere\n\nNot this one.\n", "Elsewhere");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);

    const { setup } = await openConnectFromShare(page);
    await setup.getByTestId("agent-options-toggle").click();
    const options = setup.getByTestId("agent-options");
    await options.getByTestId("agent-scope-full").check();
    await options.getByTestId("agent-only-doc").check();
    await options.getByTestId("agent-expires").selectOption("never");
    await expect(setup.getByTestId("agent-key-summary")).toHaveText("Full access · this document only · never expires");
    const [request] = await Promise.all([postsToTokens(page), setup.getByTestId("agent-create-key").click()]);
    expect(request.postDataJSON()).toEqual({ name: "Copilot CLI", expiresInDays: null, scope: "full", documentIds: [id] });

    // The pre-allow line grows with what a full key can run.
    await setup.getByText("Skip permission prompts", { exact: true }).click();
    const allowLine = setup.locator("details", { hasText: "Skip permission prompts" }).locator("pre");
    expect(await readBlock(allowLine)).toBe(
      "copilot --allow-tool 'markdoc(markdoc_suggest),markdoc(markdoc_comment),markdoc(markdoc_presence),markdoc(markdoc_append),markdoc(markdoc_create_document)'",
    );

    const key = keyIn(await readBlock(setup.getByTestId("agent-setup-snippet")));
    const auth = { Authorization: bearer(key), "Content-Type": "application/json" };
    const who = (await (await page.request.get(`${origin}/api/me`, { headers: auth })).json()) as { scope: string; documentIds: string[] | null };
    expect(who).toMatchObject({ scope: "full", documentIds: [id] });
    expect((await page.request.put(`${origin}/api/documents/${id}/content`, { headers: auth, data: { content: "# Rewritten by the bot\n" } })).status()).toBe(200);
    expect((await page.request.get(`${origin}/api/documents/${other}/content`, { headers: auth })).status()).toBe(404);
    await context.close();
  });
});
