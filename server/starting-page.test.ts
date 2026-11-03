import { createServer } from "node:http";
import { expect, it } from "vitest";
import { sendStartingResponse } from "./starting-page";

async function withStartingServer(run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(sendStartingResponse);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the starting test server address");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

it("shows browser navigations a friendly page that automatically retries", async () => {
  await withStartingServer(async (origin) => {
    const response = await fetch(`${origin}/login`, {
      headers: { accept: "text/html", connection: "close" },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("2");

    const page = await response.text();
    expect(page).toContain('<meta http-equiv="refresh" content="2">');
    expect(page).toContain("<title>Starting Markdoc</title>");
    expect(page).toContain("Markdoc is getting ready");
    expect(page).toContain("This page will refresh automatically.");
  });
});

it("keeps non-HTML startup responses as plain text", async () => {
  await withStartingServer(async (origin) => {
    const response = await fetch(`${origin}/api/health`, {
      headers: { accept: "application/json", connection: "close" },
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("starting");
    expect(response.headers.get("content-type")).toBeNull();
  });
});
