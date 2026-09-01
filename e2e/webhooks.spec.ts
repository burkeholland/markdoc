import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import { createDocument, devLogin, reloadHydrated, waitForHydration } from "./helpers";

/**
 * Settings → Webhooks: add a webhook pointing at a receiver started in this process, read the secret once,
 * press Send test and see `200` in the list; delete it. Delivery and retries are covered by
 * src/server/webhooks.test.ts.
 */
test.describe("settings · webhooks", () => {
  let receiver: Server;
  let receiverUrl: string;
  const received: { event: string | undefined; signature: string | undefined; body: string }[] = [];

  test.beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ event: req.headers["x-markdoc-event"] as string | undefined, signature: req.headers["x-markdoc-signature"] as string | undefined, body });
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/markdoc`;
  });

  test.afterAll(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  });

  test("adds a webhook, shows the secret once, Send test lands a 200 in the list", async ({ page }) => {
    await devLogin(page, "webhooks-owner");
    await page.goto("/settings");
    await waitForHydration(page);

    const card = page.getByTestId("webhooks-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Webhooks");
    await expect(page.getByTestId("webhooks-empty")).toBeVisible();

    await page.getByTestId("webhook-add").click();
    await page.getByTestId("webhook-url").fill(receiverUrl);
    await page.getByTestId("webhook-event-content.changed").check();
    await page.getByTestId("webhook-event-mention").uncheck();
    await page.getByTestId("webhook-create").click();

    const created = page.getByTestId("webhook-created");
    await expect(created).toBeVisible();
    const secret = (await page.getByTestId("webhook-secret").innerText()).trim();
    expect(secret.startsWith("whsec_")).toBeTruthy();

    const row = page.getByTestId("webhook-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(receiverUrl);
    await expect(row).toContainText("content.changed");
    await expect(row).not.toContainText("mention");
    await expect(row).toContainText("all documents");
    await expect(page.getByTestId("webhook-status")).toContainText("no deliveries yet");

    // The secret is not in the list response.
    const list = await page.request.get("/api/webhooks");
    expect(list.ok()).toBeTruthy();
    const body = (await list.json()) as { webhooks: Record<string, unknown>[] };
    expect(body.webhooks).toHaveLength(1);
    expect("secret" in body.webhooks[0]).toBeFalsy();

    await page.getByTestId("webhook-test").click();
    await expect(page.getByTestId("webhook-status")).toContainText("200", { timeout: 10_000 });
    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("test");
    expect(received[0].signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    if (process.env.SHOT_DIR) await card.screenshot({ path: `${process.env.SHOT_DIR}/settings-webhooks.png` });

    // The push path through the real server: a comment on a document lands as a signed `comment.added` delivery.
    const docId = await createDocument(page, "# Pushed\n\nA paragraph to comment on.\n", "Pushed");
    const comment = await page.request.post(`/api/documents/${docId}/comments`, { data: { action: "add", quote: "A paragraph", body: "Pushed to the hook." } });
    expect(comment.ok()).toBeTruthy();
    await expect.poll(() => received.filter((r) => r.event === "comment.added").length, { timeout: 15_000 }).toBe(1);
    const pushed = received.find((r) => r.event === "comment.added")!;
    const payload = JSON.parse(pushed.body) as { type: string; documentId: string; documentTitle: string; body: string; cursor: string };
    expect(payload).toMatchObject({ type: "comment.added", documentId: docId, documentTitle: "Pushed", body: "Pushed to the hook." });
    expect(typeof payload.cursor).toBe("string");
    expect(pushed.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    await reloadHydrated(page);
    await expect(page.getByTestId("webhook-status")).toContainText("200");

    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("webhook-delete").click();
    await expect(page.getByTestId("webhooks-empty")).toBeVisible();
  });
});
