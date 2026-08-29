import { test, expect } from "@playwright/test";
import { createDocument, openDocument } from "./helpers";

/**
 * The Share dialog's "Collaborate with an agent" card: the Copilot CLI config for this server's
 * remote MCP endpoint, a token minted in place, and Copy. The endpoint itself is covered by
 * src/app/api/mcp/route.test.ts and scripts/mcp-smoke.mjs; here we check the card and that the URL
 * it hands out really answers.
 */
test.describe("share dialog · collaborate with an agent", () => {
  test("shows the /api/mcp config for this origin, mints a token into it, and Copy puts it on the clipboard", async ({ browser }) => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByTestId("dev-login").fill("share-agent-owner");
    await page.getByTestId("dev-login-submit").click();
    await page.waitForURL((url) => url.pathname === "/");
    const id = await createDocument(page, "# Agent share\n\nHello agent.\n", "Agent share");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);

    await page.getByTestId("share-button").click();
    const card = page.getByTestId("share-agent-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Connect GitHub Copilot CLI, VS Code or any MCP client");
    await expect(card).toContainText("/mcp add");
    const config = page.getByTestId("share-agent-config");
    await expect(config).toContainText(`"url": "${origin}/api/mcp"`);
    await expect(config).toContainText('"type": "http"');
    await expect(config).toContainText(["Bearer", "MARKDOC_TOKEN"].join(" "));
    await expect(page.getByTestId("share-agent-setup-link")).toHaveAttribute("href", "/settings#tokens");

    // "Stop the permission prompts": the --allow-tool line uses the same server key as the config above it.
    const ALLOW_LINE = "copilot --allow-tool 'markdoc(markdoc_suggest),markdoc(markdoc_comment),markdoc(markdoc_presence),markdoc(markdoc_append),markdoc(markdoc_create_document)'";
    await expect(card).toContainText("Stop the permission prompts");
    const allowLine = page.getByTestId("share-agent-allow-line");
    await expect(allowLine).toContainText("markdoc(markdoc_suggest)");
    expect((await allowLine.innerText()).trim()).toBe(ALLOW_LINE);
    await page.getByTestId("share-agent-allow-copy").click();
    await expect(page.getByTestId("share-agent-allow-copy")).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ALLOW_LINE);
    if (process.env.SHOT_DIR) await card.screenshot({ path: `${process.env.SHOT_DIR}/share-agent-card-permissions.png` });

    // The URL in the card is live: a plain GET is the liveness card, tools > 0.
    const alive = await page.request.get(`${origin}/api/mcp`);
    expect(alive.ok()).toBeTruthy();
    const body = (await alive.json()) as { name: string; tools: number };
    expect(body.name).toBe("markdoc");
    expect(body.tools).toBeGreaterThan(0);

    // Create a token: the config now carries a real secret and the button is gone.
    await page.getByTestId("share-agent-create-token").click();
    await expect(config).toContainText(["Bearer", "mdk_"].join(" "));
    await expect(config).not.toContainText("MARKDOC_TOKEN");
    await expect(page.getByTestId("share-agent-create-token")).toHaveCount(0);
    // The card mints a comment-scoped token (#124): the scope is printed next to the allow line, which no longer
    // pre-allows the tools that scope cannot run (append, create_document).
    await expect(page.getByTestId("share-agent-scope-chip")).toHaveText("comment");
    await expect(page.getByTestId("share-agent-scope")).toContainText("Comment & suggest");
    expect((await allowLine.innerText()).trim()).toBe("copilot --allow-tool 'markdoc(markdoc_suggest),markdoc(markdoc_comment),markdoc(markdoc_presence)'");
    await expect(card).toContainText("comment-scoped");
    const shown = (await config.innerText()).trim();
    const parsed = JSON.parse(shown) as { mcpServers: { markdoc: { type: string; url: string; headers: { Authorization: string }; tools: string[] } } };
    expect(parsed.mcpServers.markdoc.url).toBe(`${origin}/api/mcp`);
    expect(parsed.mcpServers.markdoc.tools).toEqual(["*"]);

    // Copy puts exactly that JSON on the clipboard.
    await page.getByTestId("share-agent-copy").click();
    await expect(page.getByTestId("share-agent-copy")).toContainText("Copied");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(clipboard)).toEqual(parsed);

    // And the token it minted works against the endpoint it points at (JSON-RPC tools/list).
    const token = parsed.mcpServers.markdoc.headers.Authorization.split(" ")[1];
    const res = await page.request.post(parsed.mcpServers.markdoc.url, {
      headers: { Authorization: ["Bearer", token].join(" "), Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const list = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain("markdoc_read_document");
    expect(list.result.tools.length).toBe(body.tools);

    // …and it is really comment-scoped: reading works, rewriting is a 403 whose text says what to do instead.
    const bearer = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
    expect((await page.request.get(`${origin}/api/documents/${id}/content`, { headers: bearer })).status()).toBe(200);
    const refused = await page.request.put(`${origin}/api/documents/${id}/content`, { headers: bearer, data: { content: "# Rewritten\n" } });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("This token is comment-scoped; create a full-access token at /settings to rewrite documents");
    const who = (await (await page.request.get(`${origin}/api/me`, { headers: bearer })).json()) as { scope: string; documentIds: string[] | null };
    expect(who).toMatchObject({ scope: "comment", documentIds: null });

    // The stdio alternative is one click away.
    await page.getByTestId("share-agent-stdio-toggle").click();
    await expect(page.getByTestId("share-agent-config-stdio")).toContainText(`"MARKDOC_URL": "${origin}"`);

    await page.keyboard.press("Escape");

    // Settings lists the token with its scope chip and document count.
    await page.goto("/settings");
    const row = page.getByTestId("token-row").filter({ hasText: "GitHub Copilot CLI" }).first();
    await expect(row.getByTestId("token-scope-chip")).toHaveText("comment");
    await expect(row.getByTestId("token-documents-count")).toHaveText("all documents");
    // The create form: scope radio (default Comment & suggest) and a document picker; a Read token for this document only.
    await expect(page.getByTestId("token-scope-comment")).toBeChecked();
    await expect(page.getByTestId("token-document-access")).toHaveText("This token will access all documents.");
    await page.getByTestId("token-name").fill("Read bot");
    await page.getByTestId("token-scope-read").check();
    await page.getByTestId("token-restrict").check();
    await expect(page.getByTestId("token-create")).toBeDisabled();
    await expect(page.getByTestId("token-document-error")).toHaveText("Select at least one document when restricting a token.");
    await expect(page.getByTestId("token-document-error")).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("token-restrict")).toHaveAttribute("aria-invalid", "true");
    await page.getByTestId(`token-document-${id}`).check();
    await expect(page.getByTestId("token-create")).toBeEnabled();
    await page.getByTestId("token-create").click();
    const createdBox = page.getByTestId("token-created");
    await expect(createdBox).toContainText("Read bot");
    await expect(createdBox.getByTestId("token-scope-chip")).toHaveText("read");
    await expect(createdBox).toContainText("1 document");
    const readRow = page.getByTestId("token-row").filter({ hasText: "Read bot" }).first();
    await expect(readRow.getByTestId("token-scope-chip")).toHaveText("read");
    await expect(readRow.getByTestId("token-documents-count")).toHaveText("1 document");
    await expect(page.getByTestId("agent-connect-scope-chip")).toHaveText("read");
    const readToken = (await page.getByTestId("copy-token").innerText()).trim();
    const ro = { Authorization: ["Bearer", readToken].join(" "), "Content-Type": "application/json" };
    expect((await page.request.get(`${origin}/api/documents/${id}/content`, { headers: ro })).status()).toBe(200);
    const noComment = await page.request.post(`${origin}/api/documents/${id}/comments`, { headers: ro, data: { action: "add", quote: "Hello agent.", body: "nope" } });
    expect(noComment.status()).toBe(403);
    expect(((await noComment.json()) as { error: string }).error).toContain("read-scoped");
    const other = await createDocument(page, "# Other\n\nNot for the bot.\n", "Other");
    expect((await page.request.get(`${origin}/api/documents/${other}/content`, { headers: ro })).status()).toBe(404);
    await context.close();
  });
});
