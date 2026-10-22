import { mcpURL } from "./mcp-url";
import { expect, test } from "./fixtures";
import { mintToken, signIn, type MintedToken, type User } from "./helpers";

const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
const headers = (token?: string) => ({
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  ...(token ? { Authorization: ["Bearer", token].join(" ") } : {}),
});

test.describe("remote MCP server auth", () => {
  let user: User;
  let full: MintedToken | undefined;
  let read: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, "mcp-security");
    full = await mintToken(user.page, "MCP security test", { expiresInDays: 1 });
    read = await mintToken(user.page, "MCP security read", { expiresInDays: 1, scope: "read" });
  });

  test.afterAll(async () => {
    await full?.revoke();
    await read?.revoke();
    await user.context.close();
  });

  test("no token and a bad token are refused with 401 and a pointer to Settings", async () => {
    for (const token of [undefined, "md_not-a-real-token"]) {
      const res = await user.page.request.post(mcpURL(), { headers: headers(token), data: rpc("tools/list") });
      expect(res.status()).toBe(401);
      const body = (await res.json()) as { error: string; settings: string };
      expect(body.error).toContain("token");
      expect(body.settings).toContain("/settings");
    }
  });

  test("a valid token reaches the caller's account; GET SSE and DELETE are 405", async () => {
    const res = await user.page.request.post(mcpURL(), { headers: headers(full!.token), data: rpc("tools/call", { name: "markdoc_whoami", arguments: {} }) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain("MCP security test");
    expect((await user.page.request.get(mcpURL(), { headers: { Accept: "text/event-stream" } })).status()).toBe(405);
    expect((await user.page.request.delete(mcpURL())).status()).toBe(405);
  });

  test("a read-scope token cannot write", async () => {
    const res = await user.page.request.post(mcpURL(), {
      headers: headers(read!.token),
      data: rpc("tools/call", { name: "markdoc_create_document", arguments: { title: "nope", content: "x" } }),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/403|scope|read/i);
  });
});
