#!/usr/bin/env node
// Drives the remote MCP endpoint (/api/mcp, Streamable HTTP) through a real MCP client against a
// running Markdoc, the way GitHub Copilot CLI does with a URL and a token.
//
//   MARKDOC_URL=http://localhost:3820 MARKDOC_TOKEN=mdk_... npm run mcp:smoke
//   (optionally MARKDOC_READ_TOKEN=mdk_... — a Read-scoped token — to check that writes are refused with 403)
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

// 1b. Stateless transport: GET-as-SSE and DELETE are 405 per the MCP spec (clients probe for it).
const sse = await fetch(`${baseUrl}/api/mcp`, { headers: { Accept: "text/event-stream", Authorization: ["Bearer", token].join(" ") } });
check(sse.status === 405, `GET /api/mcp as SSE should be 405, got ${sse.status}`);
const del = await fetch(`${baseUrl}/api/mcp`, { method: "DELETE", headers: { Authorization: ["Bearer", token].join(" ") } });
check(del.status === 405, `DELETE /api/mcp should be 405, got ${del.status}`);
console.log("GET as SSE / DELETE → 405 (stateless)");

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
check(card.tools === tools.length, `GET /api/mcp card says ${card.tools} tools, tools/list returned ${tools.length}`);
console.log(`tools: ${tools.length} (same as stdio and the card) — ${names.join(", ")}`);

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
// acceptAll / rejectAll on a document with nothing pending is an idempotent no-op: plain success, decided 0, never isError.
const noop = await client.callTool({ name: "markdoc_review_suggestions", arguments: { id, action: "rejectAll" } });
check(!noop.isError, `rejectAll with nothing pending should not be isError, got: ${text(noop)}`);
check(text(noop).includes("Nothing to decide") && text(noop).includes("(0 pending)"), `rejectAll no-op text: ${text(noop)}`);
check(noop.structuredContent?.decided === 0, `rejectAll no-op should report decided 0, got: ${JSON.stringify(noop.structuredContent)}`);
console.log(`review_suggestions rejectAll with nothing pending → ${text(noop)}`);

// A reply to a thread that does not exist must surface as a tool error, not a false "Replied to thread …".
const ghost = await client.callTool({ name: "markdoc_comment", arguments: { id, action: "reply", threadId: "bogus", body: "ghost reply" } });
check(ghost.isError === true, `markdoc_comment reply to an unknown thread should be isError, got: ${text(ghost)}`);
check(text(ghost).includes("404"), `markdoc_comment reply to an unknown thread should report 404: ${text(ghost)}`);
console.log(`reply to unknown thread → isError (${text(ghost).split("\n")[0]})`);
const threads = await client.callTool({ name: "markdoc_comments", arguments: { id } });
check(!threads.isError, `markdoc_comments failed: ${text(threads)}`);
check(!text(threads).includes("ghost reply"), `phantom reply stored: ${text(threads)}`);

// Validation errors keep their detail: a 3 MB body names the field and the cap, not just "Invalid request".
const huge = await client.callTool({ name: "markdoc_create_document", arguments: { content: "x".repeat(3_000_000), title: "too big" } });
check(huge.isError === true, `3 MB create should be isError, got: ${text(huge).slice(0, 200)}`);
check(text(huge).includes("(400)") && text(huge).includes("content"), `3 MB create error should carry the zod path "content": ${text(huge)}`);
console.log(`3 MB create → isError (${text(huge).split("\n")[0].slice(0, 120)})`);

// Restoring a document that is not in the trash is an error, not "Restored".
const notTrashed = await client.callTool({ name: "markdoc_restore_document", arguments: { id } });
check(notTrashed.isError === true, `restore of a live document should be isError, got: ${text(notTrashed)}`);
check(text(notTrashed).includes("409"), `restore of a live document should report 409: ${text(notTrashed)}`);
console.log(`restore of a live document → isError (${text(notTrashed).split("\n")[0]})`);

// A watch does not wake on the token's own writes: after our own append, polling from the cursor taken
// before it sleeps out the wait and reports nothing; includeSelf shows the same change marked "(you)".
const w0 = await client.callTool({ name: "markdoc_watch", arguments: { id } });
check(!w0.isError && typeof w0.structuredContent?.cursor === "string", `markdoc_watch first call: ${text(w0)}`);
const appended = await client.callTool({ name: "markdoc_append", arguments: { id, markdown: "\nself append\n" } });
check(!appended.isError, `markdoc_append failed: ${text(appended)}`);
const t0 = Date.now();
const quiet = await client.callTool({ name: "markdoc_watch", arguments: { id, since: w0.structuredContent.cursor, wait: 2 } });
const quietMs = Date.now() - t0;
check(!quiet.isError, `markdoc_watch after own append failed: ${text(quiet)}`);
check(text(quiet).startsWith("Nothing happened"), `watch after own append should say Nothing happened, got: ${text(quiet)}`);
check(quietMs >= 1800, `watch after own append returned after ${quietMs} ms; it should have waited the full 2 s`);
const mine = await client.callTool({ name: "markdoc_watch", arguments: { id, since: w0.structuredContent.cursor, wait: 0, includeSelf: true } });
check(!mine.isError, `markdoc_watch includeSelf failed: ${text(mine)}`);
check(text(mine).includes("content.changed") && text(mine).includes("(you)") && text(mine).includes("+self append"), `includeSelf should list the own append as (you): ${text(mine)}`);
const selfEvent = mine.structuredContent?.events?.find((e) => e.type === "content.changed");
check(selfEvent?.actor?.self === true && selfEvent.actor.kind === "agent", `own content.changed should carry actor.self: ${JSON.stringify(selfEvent?.actor)}`);
console.log(`watch after own append → "${text(quiet).split("\n")[0].slice(0, 40)}…" after ${quietMs} ms; includeSelf → ${text(mine).split("\n")[0]}`);

await client.callTool({ name: "markdoc_delete_document", arguments: { id } });
await client.close();

// Scoped tokens (#124): with MARKDOC_READ_TOKEN set to a `read`-scoped token, whoami says so and a write is a
// tool error that points at /settings — not a silent success.
const readToken = process.env.MARKDOC_READ_TOKEN;
if (readToken) {
  const ro = new Client({ name: "mcp-smoke-http-read", version: "0.0.0" });
  await ro.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), { requestInit: { headers: { Authorization: ["Bearer", readToken].join(" ") } } }));
  const roWho = await ro.callTool({ name: "markdoc_whoami", arguments: {} });
  check(!roWho.isError && roWho.structuredContent?.scope === "read", `read token whoami should report scope read: ${text(roWho)}`);
  check(text(roWho).includes("with read scope"), `read token whoami text should name the scope: ${text(roWho)}`);
  const refused = await ro.callTool({ name: "markdoc_create_document", arguments: { content: "# Nope\n", title: "read token" } });
  check(refused.isError === true, `markdoc_create_document with a read token should be isError, got: ${text(refused)}`);
  check(text(refused).includes("(403)") && text(refused).includes("read-scoped") && text(refused).includes("/settings"), `read token 403 should say read-scoped and point at /settings: ${text(refused)}`);
  const roList = await ro.callTool({ name: "markdoc_list_documents", arguments: {} });
  check(!roList.isError, `markdoc_list_documents with a read token failed: ${text(roList)}`);
  await ro.close();
  console.log(`read token → whoami scope read; create_document isError (${text(refused).split("\n")[0].slice(0, 100)})`);
} else {
  console.log("MARKDOC_READ_TOKEN not set — skipping the read-scope check (mint a Read token at /settings to run it)");
}
console.log(`ALL GOOD — ${tools.length} tools over ${baseUrl}/api/mcp`);
