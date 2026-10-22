import { MCP_SERVER_KEY } from "@/lib/mcp";

/** Shown where a key goes when no real key exists yet (previews, docs). */
export const KEY_PLACEHOLDER = "MARKDOC_TOKEN";

/** Default name of a new key; it becomes the agent's name in documents. */
export const DEFAULT_KEY_NAME = "AI agent";

/** Shown until the configured MCP server URL has loaded. */
export const MCP_URL_PLACEHOLDER = "MARKDOC_MCP_URL";

export interface McpSetup {
  /** The remote (Streamable HTTP) MCP server URL. */
  url: string;
  /** The Authorization header value, key included. */
  authorization: string;
  /** A standard `mcpServers` config block with the URL and header. */
  config: string;
}

/** The one MCP setup every client uses: a URL and an Authorization header. */
export function mcpSetup(input: { mcpUrl: string; key?: string | null }): McpSetup {
  const url = input.mcpUrl || MCP_URL_PLACEHOLDER;
  const authorization = "Bearer " + (input.key || KEY_PLACEHOLDER);
  const config = JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { type: "http", url, headers: { Authorization: authorization } } } }, null, 2);
  return { url, authorization, config };
}

/**
 * The sentence a person pastes into an agent to put it into one document's watch loop:
 * `markdoc_presence` → `markdoc_watch { wait: 55 }` → act on comments, mentions and requests.
 */
export function joinDocumentPrompt(doc: { id: string; title: string }): string {
  const title = (doc.title || "Untitled").replace(/"/g, "'");
  return `Sit in the Markdoc document "${title}" (id ${doc.id}): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.`;
}

/** The one-shot version for a page with no document: pick up whatever was asked in the editor. */
export const CHECK_REQUESTS_PROMPT = "Check Markdoc for requests";
