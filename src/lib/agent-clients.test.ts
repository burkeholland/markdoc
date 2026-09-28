import { describe, expect, it } from "vitest";
import { AGENT_DOCS_URL } from "@/lib/mcp";
import {
  AGENT_CLIENTS,
  agentClient,
  CHECK_REQUESTS_PROMPT,
  clientSetup,
  COPILOT_APP_INSTALL,
  isAgentClientId,
  joinDocumentPrompt,
  KEY_PLACEHOLDER,
} from "./agent-clients";

const origin = "https://docs.example.com";
const key = "mdk_abc123";

describe("clientSetup", () => {
  it("gives Copilot CLI one command with the key in the header", () => {
    const setup = clientSetup("copilot-cli", { origin, key });
    expect(setup.snippet).toBe('copilot mcp add --transport http --header "Authorization: Bearer mdk_abc123" markdoc https://docs.example.com/api/mcp');
    expect(setup.instruction).toMatch(/new Copilot CLI session/);
  });

  it("offers the permission-prompt line for Copilot CLI, narrowed to what the key can do", () => {
    expect(clientSetup("copilot-cli", { origin, key }).extra?.snippet).toBe(
      "copilot --allow-tool 'markdoc(markdoc_suggest),markdoc(markdoc_comment),markdoc(markdoc_presence)'",
    );
    expect(clientSetup("copilot-cli", { origin, key, scope: "read" }).extra?.snippet).toBe("copilot --allow-tool 'markdoc(markdoc_presence)'");
    // The permissions line never carries the key.
    expect(clientSetup("copilot-cli", { origin, key }).extra?.snippet).not.toContain(key);
  });

  it("points VS Code at the user configuration so the key stays out of the repository", () => {
    const setup = clientSetup("vscode", { origin, key });
    expect(setup.instruction).toContain("MCP: Open User Configuration");
    expect(JSON.parse(setup.snippet)).toEqual({
      servers: { markdoc: { type: "http", url: "https://docs.example.com/api/mcp", headers: { Authorization: "Bearer mdk_abc123" } } },
    });
  });

  it("puts --header last for Claude Code, because it takes several values and would swallow the URL", () => {
    const { snippet } = clientSetup("claude-code", { origin, key });
    expect(snippet).toBe('claude mcp add --transport http --scope user markdoc https://docs.example.com/api/mcp --header "Authorization: Bearer mdk_abc123"');
    expect(snippet.indexOf("--header")).toBeGreaterThan(snippet.indexOf("/api/mcp"));
  });

  it("gives Cursor the mcpServers shape without a transport type", () => {
    const parsed = JSON.parse(clientSetup("cursor", { origin, key }).snippet);
    expect(parsed).toEqual({ mcpServers: { markdoc: { url: "https://docs.example.com/api/mcp", headers: { Authorization: "Bearer mdk_abc123" } } } });
  });

  it("gives the Copilot app two variables, plus the extension install as its second block", () => {
    const setup = clientSetup("copilot-app", { origin, key });
    expect(setup.snippet).toBe("MARKDOC_URL=https://docs.example.com\nMARKDOC_TOKEN=mdk_abc123");
    expect(setup.extra).toMatchObject({ title: "Install the extension", snippet: COPILOT_APP_INSTALL });
    expect(setup.docs).toEqual({ label: "Copilot app setup and limits", href: `${AGENT_DOCS_URL}#inside-the-copilot-app` });
    expect(AGENT_CLIENTS.filter((client) => clientSetup(client.id, { origin, key }).docs).map((client) => client.id)).toEqual(["copilot-app"]);
  });

  it("gives any other client the generic remote server, with a stdio fallback", () => {
    const setup = clientSetup("other", { origin, key });
    expect(JSON.parse(setup.snippet)).toEqual({
      mcpServers: { markdoc: { type: "http", url: "https://docs.example.com/api/mcp", headers: { Authorization: "Bearer mdk_abc123" }, tools: ["*"] } },
    });
    const stdio = JSON.parse(setup.extra!.snippet);
    expect(stdio.mcpServers.markdoc).toMatchObject({ command: "node", env: { MARKDOC_URL: origin, MARKDOC_TOKEN: key } });
  });

  it("shows a placeholder instead of a key when there is none", () => {
    for (const { id } of AGENT_CLIENTS) {
      const setup = clientSetup(id, { origin });
      expect(setup.snippet).toContain(KEY_PLACEHOLDER);
      expect(setup.snippet).not.toContain("mdk_");
    }
  });

  it("falls back to a local origin before the browser origin is known", () => {
    expect(clientSetup("copilot-cli", { origin: "", key }).snippet).toContain("http://localhost:3000/api/mcp");
  });

  it("never repeats the key in a client's permissions or install block", () => {
    for (const { id } of AGENT_CLIENTS) {
      const extra = clientSetup(id, { origin, key }).extra;
      if (id === "other") continue; // the stdio fallback needs the key by design
      if (extra) expect(extra.snippet).not.toContain(key);
    }
  });
});

describe("agent clients", () => {
  it("lists the six clients with unique ids and default key names", () => {
    expect(AGENT_CLIENTS.map((c) => c.id)).toEqual(["copilot-cli", "vscode", "claude-code", "cursor", "copilot-app", "other"]);
    expect(new Set(AGENT_CLIENTS.map((c) => c.keyName)).size).toBe(AGENT_CLIENTS.length);
  });

  it("recognises client ids and falls back to Copilot CLI for an unknown one", () => {
    expect(isAgentClientId("cursor")).toBe(true);
    expect(isAgentClientId("emacs")).toBe(false);
    expect(isAgentClientId(null)).toBe(false);
    expect(agentClient("vscode").label).toBe("VS Code");
    expect(agentClient("nope" as never).id).toBe("copilot-cli");
  });
});

describe("prompts", () => {
  it("asks an agent to sit in one document, quoting the title safely", () => {
    expect(joinDocumentPrompt({ id: "abc123", title: 'The "big" plan' })).toBe(
      "Sit in the Markdoc document \"The 'big' plan\" (id abc123): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.",
    );
    expect(joinDocumentPrompt({ id: "x", title: "" })).toContain('"Untitled"');
  });

  it("has a one-shot check-in for pages without a document", () => {
    expect(CHECK_REQUESTS_PROMPT).toBe("Check Markdoc for requests");
  });
});
