import { describe, expect, it } from "vitest";
import { CHECK_REQUESTS_PROMPT, joinDocumentPrompt, KEY_PLACEHOLDER, mcpSetup } from "./agent-clients";

const origin = "https://docs.example.com";
const key = "mdk_abc123";

describe("mcpSetup", () => {
  it("gives every client the same URL, header and mcpServers config", () => {
    const setup = mcpSetup({ origin, key });
    expect(setup.url).toBe("https://docs.example.com/api/mcp");
    expect(setup.authorization).toBe("Bearer " + key);
    expect(JSON.parse(setup.config)).toEqual({
      mcpServers: { markdoc: { type: "http", url: "https://docs.example.com/api/mcp", headers: { Authorization: "Bearer " + key } } },
    });
  });

  it("shows a placeholder instead of a key when there is none", () => {
    const setup = mcpSetup({ origin });
    expect(setup.config).toContain(KEY_PLACEHOLDER);
    expect(setup.config).not.toContain("mdk_");
  });

  it("falls back to a local origin before the browser origin is known", () => {
    expect(mcpSetup({ origin: "", key }).url).toBe("http://localhost:3000/api/mcp");
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
