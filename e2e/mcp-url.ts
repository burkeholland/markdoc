/** URL of the remote MCP server (markdoc-mcp) the suite runs beside markdoc; set by playwright.config.ts. */
export function mcpURL(): string {
  const url = process.env.E2E_MCP_URL;
  if (!url) throw new Error("E2E_MCP_URL is not set (playwright.config.ts sets it; with PROD_BASE_URL pass it explicitly)");
  return url;
}
