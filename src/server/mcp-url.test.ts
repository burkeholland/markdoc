import { describe, expect, it } from "vitest";
import { DEV_MCP_URL, PRODUCTION_MCP_URL, mcpServerUrl } from "./mcp-url";

describe("mcpServerUrl", () => {
  it("uses MARKDOC_MCP_URL, else mcp.markdoc.app in production and localhost:3100 in dev", () => {
    expect(mcpServerUrl({ MARKDOC_MCP_URL: "http://box:3101/mcp" })).toBe("http://box:3101/mcp");
    expect(mcpServerUrl({ NODE_ENV: "production" })).toBe(PRODUCTION_MCP_URL);
    expect(PRODUCTION_MCP_URL).toBe("https://mcp.markdoc.app/mcp");
    expect(mcpServerUrl({ NODE_ENV: "development" })).toBe(DEV_MCP_URL);
    expect(() => mcpServerUrl({ MARKDOC_MCP_URL: "ftp://x/mcp" })).toThrow();
  });
});
