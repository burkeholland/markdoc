// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AgentConnectCard } from "@/components/settings/agent-connect-card";
import { AGENT_DOCS_URL } from "@/lib/mcp";
import { KeepAgentHerePanel, keepAgentPrompt } from "./keep-agent-here";

afterEach(cleanup);

describe("keepAgentPrompt", () => {
  it("names the document, its id and the two MCP tools of the watch loop", () => {
    const s = keepAgentPrompt({ id: "abc123", title: "Launch plan" });
    expect(s).toBe(
      'Sit in the Markdoc document "Launch plan" (id abc123): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.',
    );
  });

  it("keeps the quoted title unambiguous and falls back to Untitled", () => {
    expect(keepAgentPrompt({ id: "x", title: 'Say "hi"' })).toContain(`"Say 'hi'"`);
    expect(keepAgentPrompt({ id: "x", title: "" })).toContain('"Untitled"');
  });
});

describe("agent documentation links", () => {
  it("gives every standalone documentation link an inline 24px hit area", () => {
    const card = render(createElement(AgentConnectCard, { origin: "https://markdoc.test" }));
    const agentDocs = screen.getByTestId("agent-docs-link");
    expect(agentDocs).toHaveClass("inline-flex", "min-h-6");
    expect(agentDocs).toHaveAttribute("href", AGENT_DOCS_URL);

    fireEvent.click(screen.getByTestId("agent-connect-tab-copilot-app"));
    expect(screen.getByRole("link", { name: "Inside the Copilot app setup and limits" })).toHaveClass("inline-flex", "min-h-6");
    card.unmount();

    render(createElement(KeepAgentHerePanel, { doc: { id: "doc-1", title: "Plan" }, active: false }));
    const keepAgentDocs = screen.getByTestId("keep-agent-docs-link");
    expect(keepAgentDocs).toHaveClass("inline-flex", "min-h-6");
    expect(keepAgentDocs).toHaveAttribute("href", `${AGENT_DOCS_URL}#sit-in-a-document`);
    expect(keepAgentDocs).toHaveAttribute("target", "_blank");
  });
});
