/** Where the agent guide lives (there is no in-app docs route) and the remote MCP endpoint path. */
export const AGENT_DOCS_URL = "https://github.com/burkeholland/markdoc/blob/main/docs/agents.md";
export const MCP_PATH = "/api/mcp";

/** The key under `mcpServers` in the config block the UI hands out. */
export const MCP_SERVER_KEY = "markdoc";

/** Token scopes, narrowest first (mirrors `TokenScope` in the schema without importing the server). */
export type TokenScopeName = "read" | "comment" | "full";

/** The scope radio order (narrowest first), used by the connect steps' options. */
export const SCOPES: TokenScopeName[] = ["read", "comment", "full"];

/** localStorage key set once the user dismisses the "Connect an agent" row under the comments `@` picker. */
export const AGENT_CONNECT_DISMISSED_KEY = "markdoc:agent-connect-dismissed";

/** What a key may do, in the words the setup flow and the key list use. */
export const TOKEN_SCOPE_LABEL: Record<TokenScopeName, string> = { read: "Read only", comment: "Comment & suggest", full: "Full access" };
export const TOKEN_SCOPE_SUMMARY: Record<TokenScopeName, string> = {
  read: "Reads and follows along. Changes nothing.",
  comment: "Comments and suggests edits you approve.",
  full: "Everything you can do, including rewriting.",
};