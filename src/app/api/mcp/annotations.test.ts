import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ADDITIVE, DESTRUCTIVE, READ_ONLY, listToolDefinitions, listToolNames } from "../../../../mcp/tools.mjs";

/**
 * The MCP `annotations` every Markdoc tool advertises (readOnlyHint, destructiveHint, idempotentHint,
 * openWorldHint). GitHub Copilot CLI and other clients read them to decide whether to ask the user
 * before a call, so the sets below are pinned: a new tool without annotations fails `registerTools`
 * itself, and moving a tool between sets has to be a deliberate edit here.
 */
const READ_SET = [
  "markdoc_whoami",
  "markdoc_list_documents",
  "markdoc_search_documents",
  "markdoc_list_templates",
  "markdoc_read_document",
  "markdoc_suggestions",
  "markdoc_comments",
  "markdoc_versions",
  "markdoc_sync_status",
  "markdoc_list_requests",
  "markdoc_watch",
];

const DESTRUCTIVE_SET = ["markdoc_replace_content", "markdoc_review_suggestions", "markdoc_delete_document"];

const ADDITIVE_SET = [
  "markdoc_create_document",
  "markdoc_import_text",
  "markdoc_append",
  "markdoc_suggest",
  "markdoc_comment",
  "markdoc_review",
  "markdoc_publish",
  "markdoc_pull",
  "markdoc_duplicate_document",
  "markdoc_restore_document",
  "markdoc_claim_request",
  "markdoc_complete_request",
  "markdoc_presence",
];

interface ListedTool {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

describe("MCP tool annotations", () => {
  let client: Client;
  let tools: ListedTool[];

  beforeAll(async () => {
    // The real stdio server, the way a client without HTTP would run it. tools/list never calls the
    // REST API, so the URL and token only have to be present.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, "../../../../mcp/server.mjs")],
      env: { ...(process.env as Record<string, string>), MARKDOC_URL: "http://127.0.0.1:9", MARKDOC_TOKEN: "mdk_test" },
      stderr: "pipe",
    });
    client = new Client({ name: "annotations-test", version: "0.0.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    await client.connect(transport);
    tools = (await client.listTools()).tools as ListedTool[];
  });

  afterAll(async () => {
    await client?.close();
  });

  it("the three sets cover all 27 tools exactly once", () => {
    const all = [...READ_SET, ...ADDITIVE_SET, ...DESTRUCTIVE_SET];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(27);
    expect([...all].sort()).toEqual([...listToolNames()].sort());
  });

  it("tools/list over stdio returns annotations and a title on every tool", () => {
    expect(tools.map((t) => t.name)).toEqual(listToolNames());
    for (const t of tools) {
      expect(t.annotations, `${t.name} has no annotations`).toBeDefined();
      expect(typeof t.annotations?.readOnlyHint, `${t.name}.readOnlyHint`).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint, `${t.name}.destructiveHint`).toBe("boolean");
      expect(typeof t.annotations?.idempotentHint, `${t.name}.idempotentHint`).toBe("boolean");
      expect(t.annotations?.openWorldHint, `${t.name}.openWorldHint`).toBe(false);
      expect(t.title, `${t.name} has no title`).toBeTruthy();
    }
  });

  it("readOnlyHint is on exactly the read set", () => {
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly).toEqual(READ_SET);
    for (const name of READ_SET) expect(tools.find((t) => t.name === name)?.annotations).toEqual(READ_ONLY);
  });

  it("destructiveHint is on exactly replace_content, review_suggestions and delete_document", () => {
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
    expect(destructive).toEqual(DESTRUCTIVE_SET);
    for (const name of DESTRUCTIVE_SET) expect(tools.find((t) => t.name === name)?.annotations).toEqual(DESTRUCTIVE);
  });

  it("additive writes are neither read-only nor destructive", () => {
    const additive = tools.filter((t) => t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false).map((t) => t.name);
    expect(additive).toEqual(ADDITIVE_SET);
    for (const name of ADDITIVE_SET) expect(tools.find((t) => t.name === name)?.annotations).toEqual(ADDITIVE);
  });

  it("listToolDefinitions() matches what the wire carries", () => {
    const defs = listToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(tools.map((t) => t.name));
    for (const d of defs) {
      const wire = tools.find((t) => t.name === d.name);
      expect(wire?.annotations).toEqual(d.annotations);
      expect(wire?.title).toBe(d.title);
    }
  });
});
