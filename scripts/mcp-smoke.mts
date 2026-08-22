// Drives mcp/server.mjs through a real MCP client (stdio) against a running Markdoc.
// Usage: BASE_URL=http://localhost:3000 MARKDOC_TOKEN=mdk_... npx tsx scripts/mcp-smoke.mts
// Without MARKDOC_TOKEN it mints one through the UI with the dev login.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, expect } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3000";
let token = process.env.MARKDOC_TOKEN;
if (!token) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/login`);
  await page.getByTestId("dev-login").fill("mcp-smoke");
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL(`${base}/`);
  await page.goto(`${base}/settings`);
  await page.waitForResponse((r) => r.url().endsWith("/api/tokens") && r.request().method() === "GET");
  await page.waitForTimeout(300);
  await page.getByTestId("token-name").fill("Copilot (MCP smoke)");
  await page.getByTestId("token-create").click();
  await page.getByTestId("token-created").waitFor();
  token = (await page.getByTestId("copy-token").innerText()).trim();
  await browser.close();
}

const transport = new StdioClientTransport({ command: "node", args: ["mcp/server.mjs"], env: { ...process.env, MARKDOC_URL: base, MARKDOC_TOKEN: token! } as Record<string, string> });
const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
expect(tools.tools.map((t) => t.name)).toContain("markdoc_suggest");

const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { type: string; text: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const structured = (r: Awaited<ReturnType<typeof client.callTool>>) => r.structuredContent as Record<string, unknown>;

const who = await client.callTool({ name: "markdoc_whoami", arguments: {} });
console.log(text(who));

const created = await client.callTool({ name: "markdoc_create_document", arguments: { content: "# Written with Copilot\n\nWe drafted this together in the CLI.\n" } });
const id = structured(created).id as string;
console.log(text(created));
expect(String(structured(created).url)).toBe(`${base}/d/${id}`);

await client.callTool({ name: "markdoc_append", arguments: { id, markdown: "## Open questions\n\n- Who reviews?" } });
const read = await client.callTool({ name: "markdoc_read_document", arguments: { id } });
expect(text(read)).toContain("Open questions");

const sug = await client.callTool({ name: "markdoc_suggest", arguments: { id, edits: [{ find: "drafted this together", replace: "wrote this together" }] } });
console.log(text(sug));
const list = await client.callTool({ name: "markdoc_suggestions", arguments: { id } });
console.log(text(list));
expect(text(list)).toContain("Copilot (MCP smoke)");

const commented = await client.callTool({ name: "markdoc_comment", arguments: { id, action: "add", quote: "Who reviews?", body: "Burke, can you assign a reviewer?" } });
console.log(text(commented));
const threads = await client.callTool({ name: "markdoc_comments", arguments: { id } });
expect(text(threads)).toContain("assign a reviewer");

await client.callTool({ name: "markdoc_review_suggestions", arguments: { id, action: "acceptAll" } });
const after = await client.callTool({ name: "markdoc_read_document", arguments: { id, clean: true } });
expect(text(after)).toContain("wrote this together");
const versions = await client.callTool({ name: "markdoc_versions", arguments: { id } });
console.log(text(versions));

const docs = await client.callTool({ name: "markdoc_list_documents", arguments: {} });
expect(text(docs)).toContain(id);
await client.close();
console.log("ALL GOOD", `${base}/d/${id}`);
