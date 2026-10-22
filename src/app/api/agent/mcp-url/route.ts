import { handler, json } from "@/server/http";
import { mcpServerUrl } from "@/server/mcp-url";

export const dynamic = "force-dynamic";

/** Where the "Connect an AI agent" steps point MCP clients (runtime `MARKDOC_MCP_URL`). Public: it is in every snippet anyway. */
export const GET = handler(async () => json({ url: mcpServerUrl() }));
