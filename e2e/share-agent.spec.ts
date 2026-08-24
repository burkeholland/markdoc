import { test, expect } from "@playwright/test";
import { signIn, createDocument, openDocument } from "./helpers";

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

    // The stdio alternative is one click away.
    await page.getByTestId("share-agent-stdio-toggle").click();
    await expect(page.getByTestId("share-agent-config-stdio")).toContainText(`"MARKDOC_URL": "${origin}"`);

    await page.keyboard.press("Escape");
    await context.close();
  });
});
