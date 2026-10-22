/** Production MCP server (burkeholland/markdoc-mcp, Streamable HTTP). */
export const PRODUCTION_MCP_URL = "https://mcp.markdoc.app/mcp";
/** `npm start` in a markdoc-mcp checkout listens here by default. */
export const DEV_MCP_URL = "http://localhost:3100/mcp";

/** The MCP server URL agents are told to use: `MARKDOC_MCP_URL`, else the production or local default. */
export function mcpServerUrl(env: Partial<Pick<NodeJS.ProcessEnv, "MARKDOC_MCP_URL" | "NODE_ENV">> = process.env): string {
  const configured = env.MARKDOC_MCP_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MARKDOC_MCP_URL must be an http(s) URL");
    return url.href;
  }
  return env.NODE_ENV === "production" ? PRODUCTION_MCP_URL : DEV_MCP_URL;
}
