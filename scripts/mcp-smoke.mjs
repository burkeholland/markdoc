#!/usr/bin/env node
// Drives the remote MCP endpoint (/api/mcp, Streamable HTTP) through a real MCP client against a
// running Markdoc, the way GitHub Copilot CLI does with a URL and a token.
//
//   MARKDOC_URL=http://localhost:3820 MARKDOC_TOKEN=mdk_... npm run mcp:smoke
//
// Lists the tools (same set as the stdio server, each with its annotations), calls markdoc_whoami,
// creates a document, reads it back and checks that reviewing a suggestion that does not exist is an
// error. Exits non-zero on the first mismatch. See scripts/mcp-smoke.mts for the stdio run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { listToolDefinitions, listToolNames } from "../mcp/tools.mjs";

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

// 4. Every tool carries the MCP annotations Copilot CLI reads to decide whether to prompt.
const defined = new Map(listToolDefinitions().map((t) => [t.name, t.annotations]));
const hint = (a) => (!a ? "MISSING" : a.readOnlyHint ? "read-only" : a.destructiveHint ? "destructive" : "additive");
for (const t of tools) {
  check(t.annotations && typeof t.annotations.readOnlyHint === "boolean", `${t.name} has no annotations over HTTP`);
  check(JSON.stringify(t.annotations) === JSON.stringify(defined.get(t.name)), `${t.name} annotations differ from mcp/tools.mjs: ${JSON.stringify(t.annotations)}`);
  check(t.annotations.openWorldHint === false, `${t.name} should have openWorldHint: false`);
  console.log(`  ${t.name.padEnd(28)} ${hint(t.annotations).padEnd(12)} ${t.title ?? ""}`);
}
const byHint = tools.reduce((acc, t) => ((acc[hint(t.annotations)] = (acc[hint(t.annotations)] ?? 0) + 1), acc), {});
console.log(`annotations: ${Object.entries(byHint).map(([k, v]) => `${v} ${k}`).join(", ")}`);

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

// A decision on a suggestion that does not exist (or with no id at all) must be an error, not "done".
const bogus = await client.callTool({ name: "markdoc_review_suggestions", arguments: { id, action: "accept", suggestionId: "bogus" } });
check(bogus.isError === true, `review_suggestions with a bogus id should be isError, got: ${text(bogus)}`);
check(text(bogus).includes("Suggestion not found"), `bogus id error should say Suggestion not found: ${text(bogus)}`);
const noId = await client.callTool({ name: "markdoc_review_suggestions", arguments: { id, action: "accept" } });
check(noId.isError === true, `review_suggestions without suggestionId should be isError, got: ${text(noId)}`);
console.log(`review_suggestions bogus/missing id: both isError`);

// A reply to a thread that does not exist must surface as a tool error, not a false "Replied to thread …".
const ghost = await client.callTool({ name: "markdoc_comment", arguments: { id, action: "reply", threadId: "bogus", body: "ghost reply" } });
check(ghost.isError === true, `markdoc_comment reply to an unknown thread should be isError, got: ${text(ghost)}`);
check(text(ghost).includes("404"), `markdoc_comment reply to an unknown thread should report 404: ${text(ghost)}`);
console.log(`reply to unknown thread → isError (${text(ghost).split("\n")[0]})`);
const threads = await client.callTool({ name: "markdoc_comments", arguments: { id } });
check(!threads.isError, `markdoc_comments failed: ${text(threads)}`);
check(!text(threads).includes("ghost reply"), `phantom reply stored: ${text(threads)}`);

await client.callTool({ name: "markdoc_delete_document", arguments: { id } });
await client.close();
console.log(`ALL GOOD — ${tools.length} tools over ${baseUrl}/api/mcp`);
