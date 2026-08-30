import { expect, test } from "@playwright/test";
import { createDocument, mintToken, signIn, type MintedToken } from "./helpers";

const extensionModule = "../extensions/markdoc/extension-core.mjs";

interface TestCanvas {
  open(context: { instanceId: string; input: { id: string } }): Promise<{ url: string }>;
  onClose(context: { instanceId: string }): Promise<void>;
}

test("the loopback canvas spends a token handoff and frames the editor without dashboard chrome", async ({ browser }) => {
  const owner = await signIn(browser, "copilot-canvas-owner");
  const canvasContext = await browser.newContext();
  let canvas: TestCanvas | undefined;
  let minted: MintedToken | undefined;
  try {
    const { startMarkdocExtension } = await import(extensionModule);
    const documentId = await createDocument(owner.page, "# Canvas\n\nEdit this document with Copilot.\n", "Canvas document");
    minted = await mintToken(owner.page, "Copilot app", { scope: "full", documentIds: [documentId] });
    const token = minted.token;
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
    // #1075: no separate ask button; the toolbar ends with Comment, and a comment that mentions an agent is the request.
    await expect(editor.getByTestId("tb-comment")).toBeVisible();
    await expect(editor.locator(`[data-testid^="${["ask", "agent"].join("-")}"]`)).toHaveCount(0);
    await expect(editor.getByTestId("comments-toggle")).toBeVisible();
    await expect(editor.getByTestId("mode-switcher")).toBeVisible();
    await expect(editor.getByTestId("presence")).toBeVisible();
    // Agent state lives in the presence stack in the embed too: no purple pills in the header.
    await expect(header.locator('[data-testid="agent-pill"], [data-testid="agent-requests-pill"], [data-testid="agent-activity"]')).toHaveCount(0);
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
    // Since de84c79 the proxy scopes the frame-ancestors policy to the embedded document URL (`?embed=1`).
    const documentResponse = await embeddedFrame!.goto(`${appOrigin}/d/${documentId}?embed=1`);
    expect(documentResponse?.headers()["content-security-policy"]).toBe(`frame-ancestors ${new URL(opened.url).origin}`);
    await expect(editor.getByTestId("header")).toHaveAttribute("data-embed", "true");
    await expect(editor.getByTestId("storage-indicator")).toBeDisabled();
    // The editors mount on the client, so once they are visible the freshly navigated frame is hydrated and clicks land.
    await expect(editor.locator(".md-rich")).toBeVisible();
    await expect(editor.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    await editor.getByTestId("comments-toggle").click();
    await expect(editor.getByTestId("comments-panel")).toBeVisible();
    // The Copilot app sits in presence as an agent, so the `@` picker offers it as one that is here; the request made
    // from the embed shows up as a chip on the thread and in the popover's Requests section (Cancel included) — no
    // waiting placeholder and no "Keep an agent here" while it is here.
    const stack = editor.getByTestId("presence");
    await expect(stack.locator('[data-testid="presence-avatar"][data-agent]')).toHaveCount(1);
    await editor.getByTestId("comment-document").click();
    const composer = editor.getByTestId("pending-comment").getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await composer.pressSequentially("@Cop");
    const option = editor.getByTestId("mention-suggestions").locator(`[data-testid="mention-option"][data-login="${owner.login}/Copilot-app"]`);
    await expect(option).toHaveCount(1);
    await option.click();
    await expect(composer).toHaveValue(`@${owner.login}/Copilot-app `);
    await expect(editor.getByTestId("composer-agent-row")).toBeVisible();
    await composer.pressSequentially("Tighten this");
    await editor.getByTestId("comment-submit").click();
    const thread = editor.getByTestId("comment-thread").filter({ hasText: "Tighten this" });
    await expect(thread.getByTestId("comment-request-chip")).toHaveAttribute("data-status", "open");
    await stack.click();
    const popover = editor.getByTestId("presence-popover");
    await expect(popover.getByTestId("presence-request")).toHaveCount(1);
    await expect(popover.getByTestId("presence-request")).toContainText("Tighten this");
    await expect(popover.getByTestId("presence-request-cancel")).toBeVisible();
    await expect(stack.getByTestId("presence-waiting")).toHaveCount(0);
    await expect(popover.getByTestId("keep-agent-here")).toHaveCount(0);
  } finally {
    await canvas?.onClose({ instanceId: "e2e-canvas" });
    // After the extension has let go of the document: revoking disconnects the token's collab sessions.
    await minted?.revoke();
    await canvasContext.close();
    await owner.context.close();
  }
});
