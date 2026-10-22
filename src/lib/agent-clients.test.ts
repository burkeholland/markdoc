import { describe, expect, it } from "vitest";
import { CHECK_REQUESTS_PROMPT, joinDocumentPrompt, KEY_PLACEHOLDER, MCP_URL_PLACEHOLDER, mcpSetup } from "./agent-clients";

const mcpUrl = "https://mcp.markdoc.app/mcp";
const key = "mdk_abc123";

describe("mcpSetup", () => {
  it("gives every client the same URL, header and mcpServers config", () => {
    const setup = mcpSetup({ mcpUrl, key });
    expect(setup.url).toBe(mcpUrl);
    expect(setup.authorization).toBe("Bearer " + key);
    expect(JSON.parse(setup.config)).toEqual({
      mcpServers: { markdoc: { type: "http", url: mcpUrl, headers: { Authorization: "Bearer " + key } } },
    });
  });

  it("shows a placeholder instead of a key when there is none", () => {
    const setup = mcpSetup({ mcpUrl });
    expect(setup.config).toContain(KEY_PLACEHOLDER);
    expect(setup.config).not.toContain("mdk_");
  });

  it("shows a placeholder URL until the configured one has loaded", () => {
    expect(mcpSetup({ mcpUrl: "", key }).url).toBe(MCP_URL_PLACEHOLDER);
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
