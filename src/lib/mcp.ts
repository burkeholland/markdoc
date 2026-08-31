/** Where the agent guide lives (there is no in-app docs route) and the remote MCP endpoint path. */
export const AGENT_DOCS_URL = "https://github.com/burkeholland/markdoc/blob/main/docs/agents.md";
export const MCP_PATH = "/api/mcp";

/**
 * The key under `mcpServers` in the config blocks the UI hands out. Copilot CLI's `--allow-tool`
 * patterns are `<server key>(<tool>)`, so the allow line below has to use the very same string.
 */
export const MCP_SERVER_KEY = "markdoc";

/**
 * Markdoc tools worth pre-allowing for a whole Copilot CLI session: additive writes whose result
 * the humans review in the app (tracked changes, comments, presence, append, new documents). Read-only
 * tools carry `readOnlyHint` and destructive ones (replace_content, review_suggestions,
 * delete_document) stay behind a prompt on purpose — see the annotations in mcp/tools.mjs.
 */
export const COPILOT_PREALLOW_TOOLS = ["markdoc_suggest", "markdoc_comment", "markdoc_presence", "markdoc_append", "markdoc_create_document"] as const;

/** Token scopes, narrowest first (mirrors `TokenScope` in the schema without importing the server). */
export type TokenScopeName = "read" | "comment" | "full";

/** The scope radio order (narrowest first), shared with the Share dialog's agent card. */
export const SCOPES: TokenScopeName[] = ["read", "comment", "full"];

/** localStorage key set once the user dismisses the agent-connect card (Settings, comments panel, Keep an agent here). */
export const AGENT_CONNECT_DISMISSED_KEY = "markdoc:agent-connect-dismissed";

/** The pre-allow tools a token of this scope can actually run: no point pre-allowing what the server refuses with 403. */
const PREALLOW_BY_SCOPE: Record<TokenScopeName, readonly (typeof COPILOT_PREALLOW_TOOLS)[number][]> = {
  read: ["markdoc_presence"],
  comment: ["markdoc_suggest", "markdoc_comment", "markdoc_presence"],
  full: COPILOT_PREALLOW_TOOLS,
};

/** Short labels for the scope chips and the line under the config blocks. */
export const TOKEN_SCOPE_LABEL: Record<TokenScopeName, string> = { read: "Read", comment: "Comment & suggest", full: "Full" };
export const TOKEN_SCOPE_SUMMARY: Record<TokenScopeName, string> = {
  read: "reads documents, watches and shows presence — cannot write",
  comment: "reads, comments, proposes suggestions and reviews, picks up requests — cannot rewrite, publish or delete",
  full: "everything you can do",
};

/** The one-liner that starts Copilot CLI with those tools pre-allowed, byte-for-byte what the cards copy. */
export function copilotAllowToolLine(serverKey: string = MCP_SERVER_KEY, scope: TokenScopeName = "full"): string {
  return `copilot --allow-tool '${PREALLOW_BY_SCOPE[scope].map((tool) => `${serverKey}(${tool})`).join(",")}'`;
}

/** Official reference for `--allow-tool`, `/allow-all` and the persisted "don't ask again" approvals. */
export const COPILOT_ALLOWING_TOOLS_URL = "https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools";
