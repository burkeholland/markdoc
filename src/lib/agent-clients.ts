import { AGENT_DOCS_URL, copilotAllowToolLine, MCP_PATH, MCP_SERVER_KEY, type TokenScopeName } from "@/lib/mcp";

/** Shown where a key goes when no real key exists yet (previews, docs). */
export const KEY_PLACEHOLDER = "MARKDOC_TOKEN";

/** Used only before the browser origin is known (server render); a snippet is never built from it in practice. */
const FALLBACK_ORIGIN = "http://localhost:3000";

export type AgentClientId = "copilot-cli" | "vscode" | "claude-code" | "cursor" | "copilot-app" | "other";

export interface AgentClient {
  id: AgentClientId;
  /** What the picker shows. */
  label: string;
  /** Default name of the key made for this client; it becomes the agent's name in documents. */
  keyName: string;
}

export const AGENT_CLIENTS: readonly AgentClient[] = Object.freeze([
  { id: "copilot-cli", label: "Copilot CLI", keyName: "Copilot CLI" },
  { id: "vscode", label: "VS Code", keyName: "VS Code" },
  { id: "claude-code", label: "Claude Code", keyName: "Claude Code" },
  { id: "cursor", label: "Cursor", keyName: "Cursor" },
  { id: "copilot-app", label: "Copilot app", keyName: "Copilot app" },
  { id: "other", label: "Other", keyName: "MCP client" },
]);

export function agentClient(id: AgentClientId): AgentClient {
  return AGENT_CLIENTS.find((client) => client.id === id) ?? AGENT_CLIENTS[0];
}

export function isAgentClientId(value: unknown): value is AgentClientId {
  return AGENT_CLIENTS.some((client) => client.id === value);
}

/** Copies the canvas extension out of a Markdoc checkout into the Copilot app's personal extensions folder. */
export const COPILOT_APP_INSTALL = "mkdir -p ~/.copilot/extensions/markdoc && cp -R extensions/markdoc/. ~/.copilot/extensions/markdoc/";

export interface ClientSetup {
  /** One sentence: what to do with the snippet. */
  instruction: string;
  /** The text to copy. */
  snippet: string;
  /** An optional second block: permissions, install, or a fallback transport. */
  extra?: { title: string; instruction: string; snippet: string };
  /** Where the client's setup and limits are explained in more depth. */
  docs?: { label: string; href: string };
}

export interface ClientSetupInput {
  origin: string;
  /** The secret of a key created a moment ago; a placeholder is shown when omitted. */
  key?: string | null;
  /** What the key may do; narrows the Copilot CLI pre-allow line. */
  scope?: TokenScopeName;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** What a person pastes or runs to add Markdoc's MCP server to one client. */
export function clientSetup(id: AgentClientId, input: ClientSetupInput): ClientSetup {
  const url = `${input.origin || FALLBACK_ORIGIN}${MCP_PATH}`;
  const authorization = `Bearer ${input.key || KEY_PLACEHOLDER}`;
  const server = { type: "http", url, headers: { Authorization: authorization } };

  switch (id) {
    case "copilot-cli":
      return {
        instruction: "Run this in your terminal, then start a new Copilot CLI session.",
        snippet: `copilot mcp add --transport http --header "Authorization: ${authorization}" ${MCP_SERVER_KEY} ${url}`,
        extra: {
          title: "Skip permission prompts",
          instruction: "Optional. Start Copilot with Markdoc's everyday tools already allowed.",
          snippet: copilotAllowToolLine(MCP_SERVER_KEY, input.scope ?? "comment"),
        },
      };
    case "vscode":
      return {
        instruction:
          "In VS Code, run “MCP: Open User Configuration” from the Command Palette and merge this in. Use the user file, not .vscode/mcp.json, so the key stays out of your repository.",
        snippet: json({ servers: { [MCP_SERVER_KEY]: server } }),
      };
    case "claude-code":
      // --header takes several values, so it goes last or it would swallow the positional arguments.
      return {
        instruction: "Run this in your terminal. --scope user makes it work in every project.",
        snippet: `claude mcp add --transport http --scope user ${MCP_SERVER_KEY} ${url} --header "Authorization: ${authorization}"`,
      };
    case "cursor":
      return {
        instruction: "Add this to ~/.cursor/mcp.json (create the file if it is missing), then restart Cursor.",
        snippet: json({ mcpServers: { [MCP_SERVER_KEY]: { url, headers: { Authorization: authorization } } } }),
      };
    case "copilot-app":
      return {
        instruction: "Set these two variables in the environment that launches the Copilot app, then start a new session.",
        snippet: `MARKDOC_URL=${input.origin || FALLBACK_ORIGIN}\nMARKDOC_TOKEN=${input.key || KEY_PLACEHOLDER}`,
        extra: {
          title: "Install the extension",
          instruction: "Once, from a Markdoc checkout:",
          snippet: COPILOT_APP_INSTALL,
        },
        docs: { label: "Copilot app setup and limits", href: `${AGENT_DOCS_URL}#inside-the-copilot-app` },
      };
    case "other":
      return {
        instruction: "Add a remote (Streamable HTTP) MCP server to your client with this URL and header.",
        snippet: json({ mcpServers: { [MCP_SERVER_KEY]: { ...server, tools: ["*"] } } }),
        extra: {
          title: "No HTTP support?",
          instruction: "Run the server from a Markdoc checkout over stdio instead. Point args at your checkout.",
          snippet: json({
            mcpServers: {
              [MCP_SERVER_KEY]: {
                command: "node",
                args: ["/path/to/markdoc/mcp/server.mjs"],
                env: { MARKDOC_URL: input.origin || FALLBACK_ORIGIN, MARKDOC_TOKEN: input.key || KEY_PLACEHOLDER },
              },
            },
          }),
        },
      };
  }
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
