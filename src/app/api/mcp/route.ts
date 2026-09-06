import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handler, json, HttpError, resolveBearer } from "@/server/http";
import { recordMcpActivity } from "@/server/tokens";
import { mcpActivityIn } from "./activity";
import { AGENT_DOCS_URL } from "@/lib/mcp";
import { mcpPublicOrigin, mcpRestOrigin } from "@/server/mcp-origin";
import { createClient, createMarkdocServer, listToolNames, SERVER_INFO } from "../../../../mcp/tools.mjs";

/**
 * Remote MCP endpoint (Streamable HTTP): the same tool set as `mcp/server.mjs`, served by Markdoc
 * itself so any MCP client (GitHub Copilot CLI, VS Code, Claude, Cursor) connects with a URL and a
 * token instead of a checkout. Stateless: one transport per request, no session ids.
 *
 *   { "mcpServers": { "markdoc": { "type": "http", "url": "<origin>/api/mcp",
 *                                  "headers": { "Authorization": "Bearer mdk_…" } } } }
 *
 * Auth is the same token resolver as every `/api/*` route. The tools call the REST API back at the
 * server-controlled `MARKDOC_INTERNAL_URL`, `MARKDOC_URL`, or loopback `PORT`, forwarding the
 * caller's token, so access and attribution are exactly the REST ones.
 */
export const dynamic = "force-dynamic";

const TOOL_NAMES = listToolNames();
const TOKEN_HINT = "Create a token at /settings (Agents & API access → Create a token) and send it as Authorization: Bearer <token>.";
const unauthorized = (why: string) => new HttpError(401, `${why} ${TOKEN_HINT}`, { docs: AGENT_DOCS_URL, settings: "/settings#tokens" });

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

/** Resolve the caller and hand the request to a fresh MCP server + transport. */
async function serve(req: Request): Promise<Response> {
  const token = bearerToken(req);
  if (!token) throw unauthorized("Authorization: Bearer <token> is required.");
  const actor = await resolveBearer(token, req.headers);
  if (!actor) throw unauthorized("This endpoint is for API tokens (agents).");
  // The Settings checklist reads these: connected (tools/list) and working (tools/call). Off the hot path.
  for (const kind of await mcpActivityIn(req)) void recordMcpActivity(actor.tokenId, kind).catch(() => {});

  const client = createClient({
    baseUrl: mcpRestOrigin(),
    publicUrl: mcpPublicOrigin(req),
    token,
  });
  const server = createMarkdocServer(client);
  // MCP clients are not browsers: no Origin header, any Host (LAN IP, tunnel) — so no DNS-rebinding checks.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: false });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Stateless: nothing to keep between requests; with JSON responses the body is complete by now.
    void server.close().catch(() => {});
  }
}

/**
 * The transport is stateless (no session ids), so there is no standalone SSE stream to open and no
 * session to close: the MCP spec wants `405` for GET-as-SSE and DELETE in that case, and clients
 * probe for it.
 */
const methodNotAllowed = (what: string) =>
  json({ error: "Method Not Allowed", detail: `${what} is not supported: this MCP endpoint is stateless. POST JSON-RPC messages; there is no SSE stream to open and no session to delete.` }, { status: 405, headers: { Allow: "GET, POST" } });

/** A plain GET answers a liveness card a curl can read; an MCP GET (SSE stream) is refused (stateless). */
export const GET = handler(async (req: Request) => {
  if (req.headers.get("accept")?.includes("text/event-stream")) return methodNotAllowed("GET as an SSE stream");
  return json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: "streamable-http",
    tools: TOOL_NAMES.length,
    docs: AGENT_DOCS_URL,
    auth: "Authorization: Bearer <token> — create one at /settings",
  });
});

export const POST = handler(serve);
export const DELETE = handler(async (req: Request) => methodNotAllowed(req.method));
