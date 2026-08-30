import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { mintToken, signIn, type MintedToken, type User } from "./helpers";

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Expected an IP listener"));
      else resolve(address.port);
    });
  });

test.describe("remote MCP callback origin", () => {
  let user: User;
  let token: string;
  let minted: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, "mcp-security");
    minted = await mintToken(user.page, "MCP security test", { expiresInDays: 1 });
    token = minted.token;
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await user.context.close();
  });

  test("the custom server never sends token-bearing REST calls to forwarded hosts", async () => {
    let captured = 0;
    const capture = createServer((_req, res) => {
      captured++;
      res.writeHead(500).end();
    });
    const port = await listen(capture);
    try {
      const response = await user.page.request.post("/api/mcp", {
        headers: {
          Authorization: ["Bearer", token].join(" "),
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Host: `127.0.0.1:${port}`,
          "X-Forwarded-Host": `127.0.0.1:${port}`,
          "X-Forwarded-Proto": "http",
          Forwarded: `for=192.0.2.1;host="127.0.0.1:${port}";proto=http`,
        },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "markdoc_whoami", arguments: {} },
        },
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(body.result.isError).toBeFalsy();
      expect(body.result.content[0].text).toContain("MCP security test");
      expect(captured).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => capture.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
