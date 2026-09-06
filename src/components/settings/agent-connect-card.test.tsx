// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentConnectCard, mcpConfigFor, mcpHttpConfigFor, mcpVsCodeConfigFor, TOKEN_PLACEHOLDER } from "./agent-connect-card";
import { MCP_PATH } from "@/lib/mcp";

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({ ...await original<typeof import("@/lib/clipboard")>(), copyText }));

beforeEach(() => { copyText.mockReset().mockResolvedValue(true); });
afterEach(cleanup);

describe("MCP setup disclosure", () => {
  it("uses the existing endpoint and placeholder in both supported HTTP configuration shapes", () => {
    const origin = "https://markdoc.example.test";
    const cli = JSON.parse(mcpHttpConfigFor(origin));
    const vscode = JSON.parse(mcpVsCodeConfigFor(origin));
    expect(cli.mcpServers.markdoc.url).toBe(`${origin}${MCP_PATH}`);
    expect(vscode.servers.markdoc.url).toBe(`${origin}${MCP_PATH}`);
    expect(vscode.servers.markdoc.headers.Authorization).toBe(`Bearer ${TOKEN_PLACEHOLDER}`);
    expect(cli.mcpServers.markdoc.headers.Authorization).toBe(`Bearer ${TOKEN_PLACEHOLDER}`);
    const stdio = JSON.parse(mcpConfigFor(origin));
    expect(stdio.mcpServers.markdoc.env).toEqual({ MARKDOC_URL: origin, MARKDOC_TOKEN: TOKEN_PLACEHOLDER });
  });

  it("does not guess localhost when the origin is not available yet", () => {
    render(<AgentConnectCard origin="" hideTokenStep />);
    expect(screen.getByText("Determining this server's address...")).toBeVisible();
    expect(screen.queryByTestId("agent-connect-config")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy MCP configuration" })).toBeNull();
  });

  it.each(["Copilot CLI", "VS Code", "Other MCP clients"])("copies client-specific stdio after opening it for %s and switching clients", async (initial) => {
    const origin = "https://markdoc.example.test";
    render(<AgentConnectCard origin={origin} hideTokenStep />);
    fireEvent.click(screen.getByRole("tab", { name: initial }));
    const stdio = screen.getByTestId("agent-connect-config-stdio");
    expect(stdio).not.toBeVisible();
    expect(copyText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-connect-stdio-toggle"));
    let copies = 0;
    for (const client of [initial, "VS Code", "Other MCP clients", "Copilot CLI"]) {
      fireEvent.click(screen.getByRole("tab", { name: client }));
      expect(stdio).toBeVisible();
      const root = client === "VS Code" ? "servers" : "mcpServers";
      const displayed = stdio.textContent!;
      expect(JSON.parse(displayed)).toEqual({
        [root]: {
          markdoc: {
            command: "node",
            args: ["/path/to/markdoc/mcp/server.mjs"],
            env: { MARKDOC_URL: origin, MARKDOC_TOKEN: TOKEN_PLACEHOLDER },
          },
        },
      });
      expect(Object.keys(JSON.parse(screen.getByTestId("agent-connect-config").textContent!))).toEqual([root]);
      expect(copyText).toHaveBeenCalledTimes(copies);
      fireEvent.click(screen.getByRole("button", { name: "Copy stdio MCP configuration" }));
      await waitFor(() => expect(copyText).toHaveBeenCalledTimes(copies + 1));
      expect(copyText.mock.calls[copies][0] === displayed).toBe(true);
      copies++;
    }
    fireEvent.click(screen.getByRole("tab", { name: "Copilot app" }));
    expect(screen.queryByTestId("agent-connect-config-stdio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy stdio MCP configuration" })).toBeNull();
    expect(copyText).toHaveBeenCalledTimes(copies);
  });

  it("keeps optional CLI permissions collapsed and omits them for other clients", () => {
    render(<AgentConnectCard origin="https://markdoc.example.test" scope="comment" hideTokenStep />);
    expect(screen.getByTestId("agent-connect-allow-line")).not.toBeVisible();
    fireEvent.click(screen.getByText("Optional Copilot CLI permissions"));
    expect(screen.getByTestId("agent-connect-allow-line")).toBeVisible();
    expect(screen.getByTestId("agent-connect-scope-chip")).toHaveTextContent("comment");
    fireEvent.click(screen.getByRole("tab", { name: "Other MCP clients" }));
    expect(screen.queryByTestId("agent-connect-allow-line")).toBeNull();
    expect(screen.getByTestId("agent-connect-config")).toHaveTextContent("MARKDOC_TOKEN");
  });
});
