import { expect, test } from "@playwright/test";
import { createDocument, signIn } from "./helpers";

const extensionModule = "../extensions/markdoc/extension-core.mjs";

interface TestCanvas {
  open(context: { instanceId: string; input: { id: string } }): Promise<{ url: string }>;
  onClose(context: { instanceId: string }): Promise<void>;
}

test("the loopback canvas spends a token handoff and frames the editor without dashboard chrome", async ({ browser }) => {
  const owner = await signIn(browser, "copilot-canvas-owner");
  const canvasContext = await browser.newContext();
  let canvas: TestCanvas | undefined;
  try {
    const { startMarkdocExtension } = await import(extensionModule);
    const documentId = await createDocument(owner.page, "# Canvas\n\nEdit this document with Copilot.\n", "Canvas document");
    const tokenResponse = await owner.page.request.post("/api/tokens", {
      data: { name: "Copilot app", scope: "full", documentIds: [documentId] },
    });
    expect(tokenResponse.ok()).toBeTruthy();
    const token = ((await tokenResponse.json()) as { token: { token: string } }).token.token;
    const handlers = new Map<string, () => void>();
    await startMarkdocExtension({
      createCanvas: (options: TestCanvas) => {
        canvas = options;
        return options;
      },
      joinSession: async () => ({
        send: async () => "message-id",
        log: async () => {},
        on: (name: string, handler: () => void) => {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      }),
      environment: { ...process.env, MARKDOC_URL: new URL(owner.page.url()).origin, MARKDOC_TOKEN: token },
    });
    expect(canvas).toBeDefined();
    const opened = await canvas!.open({ instanceId: "e2e-canvas", input: { id: documentId } });

    const page = await canvasContext.newPage();
    await page.goto(opened.url);
    await expect(page.locator("iframe")).toBeVisible();
    const editor = page.frameLocator("iframe");
    await expect
      .poll(() => page.frames().find((frame) => frame !== page.mainFrame())?.url())
      .toMatch(new RegExp(`/d/${documentId}\\?embed=1$`));
    await expect(editor.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    const header = editor.getByTestId("header");
    await expect(header).toHaveAttribute("data-embed", "true");
    await expect(editor.getByTestId("embed-logo")).toBeVisible();
    await expect(editor.getByTestId("toolbar")).toBeVisible();
    await expect(editor.getByTestId("ask-agent-button")).toBeVisible();
    await expect(editor.getByTestId("comments-toggle")).toBeVisible();
    await expect(editor.getByTestId("mode-switcher")).toBeVisible();
    await expect(editor.getByTestId("presence")).toBeVisible();
    await expect(editor.locator(".cm-content")).toBeVisible();
    await expect(editor.locator(".md-rich")).toBeVisible();

    await expect(header.getByRole("link", { name: "Back to documents" })).toHaveCount(0);
    await expect(editor.getByTestId("header-star")).toHaveCount(0);
    await expect(editor.getByTestId("share-button")).toHaveCount(0);
    await expect(editor.getByTestId("more-menu")).toHaveCount(0);
    await expect(editor.getByTestId("publish-button")).toHaveCount(0);
    await expect(editor.getByTestId("storage-indicator")).toBeDisabled();

    const embeddedFrame = page.frames().find((frame) => frame !== page.mainFrame());
    expect(embeddedFrame).toBeDefined();
    const appOrigin = new URL(owner.page.url()).origin;
    const cookies = await canvasContext.cookies(appOrigin);
    expect(cookies.some((cookie) => cookie.name === "markdoc.embed-session")).toBe(true);
    expect(cookies.some((cookie) => cookie.name === "authjs.session-token")).toBe(false);
    const documentResponse = await embeddedFrame!.goto(`${appOrigin}/d/${documentId}`);
    expect(documentResponse?.headers()["content-security-policy"]).toBe(`frame-ancestors ${new URL(opened.url).origin}`);
    await expect(editor.getByTestId("header")).toHaveAttribute("data-embed", "true");
    await expect(editor.getByTestId("storage-indicator")).toBeDisabled();

    await editor.getByTestId("comments-toggle").click();
    await expect(editor.getByTestId("comments-panel")).toBeVisible();
    await editor.getByTestId("ask-agent-button").click();
    await expect(editor.getByTestId("ask-agent-dialog")).toBeVisible();
  } finally {
    await canvas?.onClose({ instanceId: "e2e-canvas" });
    await canvasContext.close();
    await owner.context.close();
  }
});
