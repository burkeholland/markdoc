#!/usr/bin/env node
// Markdoc MCP server (stdio): lets agents (GitHub Copilot, Claude, Cursor, …) create, read, revise,
// comment on and review Markdoc documents through the Model Context Protocol.
//
//   MARKDOC_URL=https://your-markdoc.example.com MARKDOC_TOKEN=mdk_... node mcp/server.mjs
//
// Create a token at <MARKDOC_URL>/settings. Everything the agent does is attributed to
// "<you> via <token name>", and suggestions/comments carry the token name as the author.
//
// The same tools are served over Streamable HTTP at <MARKDOC_URL>/api/mcp (no checkout needed);
// the tool definitions are shared in mcp/tools.mjs.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, createMarkdocServer } from "./tools.mjs";

const baseUrl = (process.env.MARKDOC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env.MARKDOC_TOKEN;
if (!token) {
  console.error("MARKDOC_TOKEN is not set. Create a token at " + baseUrl + "/settings");
  process.exit(1);
}

const server = createMarkdocServer(createClient({ baseUrl, token }));
const transport = new StdioServerTransport();
await server.connect(transport);