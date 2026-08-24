import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handler, json, currentUser, HttpError } from "@/server/http";
import { AGENT_DOCS_URL } from "@/lib/mcp";
import { createClient, createMarkdocServer, listToolNames, SERVER_INFO } from "../../../../mcp/tools.mjs";

/**
 * Remote MCP endpoint (Streamable HTTP): the same tool set as `mcp/server.mjs`, served by Markdoc
 * itself so any MCP client (GitHub Copilot CLI, VS Code, Claude, Cursor) connects with a URL and a
 * token instead of a checkout. Stateless: one transport per request, no session ids.
 *
 *   { "mcpServers": { "markdoc": { "type": "http", "url": "<origin>/api/mcp",
 *                                  "headers": { "Authorization": "Bearer mdk_…" } } } }
 *
 * Auth is the same token resolver as every `/api/*` route. The tools call the REST API back over
 * HTTP at this server's own origin (`MARKDOC_URL` when set — needed behind a proxy the server cannot
 * reach itself), forwarding the caller's token, so access and attribution are exactly the REST ones.
 */
export const dynamic = "force-dynamic";

const TOOL_NAMES = listToolNames();
const TOKEN_HINT = "Create a token at /settings (Agents & API access → Create a token) and send it as Authorization: Bearer <token>.";
const unauthorized = (why: string) => new HttpError(401, `${why} ${TOKEN_HINT}`, { docs: AGENT_DOCS_URL, settings: "/settings#tokens" });

function publicOrigin(req: Request): string {
  const configured = process.env.MARKDOC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  // Trust the Host header (LAN IPs, tunnels): `req.url` can carry the bind address instead of what the client used.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return host ? `${proto}://${host}` : url.origin;
}

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

/** Resolve the caller and hand the request to a fresh MCP server + transport. */
async function serve(req: Request): Promise<Response> {
  const token = bearerToken(req);
  if (!token) throw unauthorized("Authorization: Bearer <token> is required.");
  const user = await currentUser();
  if (!user?.agent) throw unauthorized("This endpoint is for API tokens (agents).");

  const client = createClient({ baseUrl: publicOrigin(req), token });
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

/** A real MCP GET (SSE stream) goes to the transport; anything else gets a liveness card a curl can read. */
export const GET = handler(async (req: Request) => {
  if (req.headers.get("accept")?.includes("text/event-stream")) return serve(req);
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
export const DELETE = handler(serve);
