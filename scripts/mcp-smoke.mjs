#!/usr/bin/env node
// Drives the remote MCP endpoint (/api/mcp, Streamable HTTP) through a real MCP client against a
// running Markdoc, the way GitHub Copilot CLI does with a URL and a token.
//
//   MARKDOC_URL=http://localhost:3820 MARKDOC_TOKEN=mdk_... npm run mcp:smoke
//
// Lists the tools (same set as the stdio server), calls markdoc_whoami, creates a document and
// reads it back. Exits non-zero on the first mismatch. See scripts/mcp-smoke.mts for the stdio run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { listToolNames } from "../mcp/tools.mjs";

const baseUrl = (process.env.MARKDOC_URL ?? "").replace(/\/$/, "");
const token = process.env.MARKDOC_TOKEN;
if (!baseUrl || !token) {
  console.error("Set MARKDOC_URL (e.g. http://localhost:3820) and MARKDOC_TOKEN (create one at <MARKDOC_URL>/settings).");
  process.exit(2);
}

function check(cond, message) {
  if (!cond) {
    console.error("FAIL:", message);
    process.exit(1);
  }
}
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

// 1. A plain GET is the liveness card (no auth, no MCP headers).
const card = await (await fetch(`${baseUrl}/api/mcp`)).json();
check(card.name === "markdoc" && typeof card.tools === "number", `GET /api/mcp card: ${JSON.stringify(card)}`);
console.log(`GET /api/mcp → ${card.name} ${card.version}, ${card.tools} tools`);

// 2. Without a token the endpoint says where to get one.
const denied = await fetch(`${baseUrl}/api/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
check(denied.status === 401, `POST without token should be 401, got ${denied.status}`);
check((await denied.json()).error.includes("/settings"), "401 body should point at /settings");
console.log("POST without token → 401 with a hint");

// 3. The real thing: Streamable HTTP client with a bearer token.
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
  requestInit: { headers: { Authorization: ["Bearer", token].join(" ") } },
});
const client = new Client({ name: "mcp-smoke-http", version: "0.0.0" });
await client.connect(transport);
console.log(`connected; server instructions: ${(client.getInstructions() ?? "").slice(0, 60)}…`);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = listToolNames().sort();
check(names.length === expected.length && names.every((n, i) => n === expected[i]), `tool list differs from mcp/tools.mjs:\n  http:  ${names.join(", ")}\n  stdio: ${expected.join(", ")}`);
console.log(`tools: ${tools.length} (same as stdio) — ${names.join(", ")}`);

const who = await client.callTool({ name: "markdoc_whoami", arguments: {} });
check(!who.isError, `markdoc_whoami failed: ${text(who)}`);
check(text(who).startsWith("Acting as "), `unexpected whoami text: ${text(who)}`);
console.log(text(who));

const created = await client.callTool({ name: "markdoc_create_document", arguments: { content: "# Over HTTP\n\nWritten through /api/mcp.\n", title: "MCP smoke (HTTP)" } });
check(!created.isError, `markdoc_create_document failed: ${text(created)}`);
const id = created.structuredContent?.id;
check(typeof id === "string", `no id in ${JSON.stringify(created.structuredContent)}`);
check(created.structuredContent.url === `${baseUrl}/d/${id}`, `url should use ${baseUrl}: ${created.structuredContent.url}`);
console.log(text(created));

const read = await client.callTool({ name: "markdoc_read_document", arguments: { id } });
check(!read.isError, `markdoc_read_document failed: ${text(read)}`);
check(text(read).includes("Written through /api/mcp."), `read back: ${text(read)}`);
console.log(`read ${id}: ${text(read).split("\n")[0]}`);

await client.callTool({ name: "markdoc_delete_document", arguments: { id } });
await client.close();
console.log(`ALL GOOD — ${tools.length} tools over ${baseUrl}/api/mcp`);
