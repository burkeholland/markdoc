import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createDocument, devLogin, openDocument, uniqueLogin, waitForHydration } from "./helpers";

// These tests display one-time secrets; do not record the UI, network payloads or failure snapshots.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * Copy buttons on an origin without the async Clipboard API (#993: http://192.168.x.x:3000 is not a
 * secure context, so `navigator.clipboard` is undefined and every Copy used to throw). Playwright
 * cannot open an insecure context, so the API is deleted with an init script; the fallback is
 * `document.execCommand("copy")` inside the click. With both paths gone the button shows the hint
 * and the text is selected. With the API present, what lands on the clipboard is byte-equal to the text shown.
 */
const NO_CLIPBOARD_API = () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
};
const NO_EXEC_COMMAND = () => {
  document.execCommand = () => false;
};
const HINT = "Select & press Ctrl+C";
const COPIED_OR_HINT = /^(Copied|Select & press Ctrl\+C)$/;

async function signInWithin(context: BrowserContext, login: string): Promise<Page> {
  const page = await context.newPage();
  await devLogin(page, login);
  await page.waitForLoadState("networkidle");
  return page;
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function contextWithout(browser: Browser, ...scripts: (() => void)[]): Promise<BrowserContext> {
  const context = await browser.newContext();
  for (const script of scripts) await context.addInitScript(script);
  return context;
}

/** Share → "Connect an AI agent" → "Create access key": the dialog is open on the setup command, with the new key in it. */
async function openAgentSnippet(page: Page) {
  await page.getByTestId("share-button").click();
  await page.getByTestId("share-connect-agent").click();
  const dialog = page.getByTestId("agent-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("agent-create-key").click();
  await expect(dialog.getByTestId("agent-setup-snippet")).toContainText("copilot mcp add");
  return dialog;
}

/** /settings, hydrated, with the setup card open (the account already has a key, so it starts folded) and a new key made. */
async function openSettingsSnippet(page: Page) {
  await page.goto("/settings");
  await waitForHydration(page);
  await page.getByTestId("agent-setup-toggle").click();
  const setup = page.getByTestId("agent-setup");
  await setup.getByTestId("agent-create-key").click();
  await expect(setup.getByTestId("agent-setup-snippet")).toContainText("copilot mcp add");
  return setup;
}

test.describe("copy buttons without navigator.clipboard (plain-HTTP LAN origin)", () => {
  test("Share, the connect dialog and Settings copy without a page error", async ({ browser }) => {
    const context = await contextWithout(browser, NO_CLIPBOARD_API);
    // Per run: the dialog and Settings each make a key. The wizard picks a free name, but a fixed login would pile keys up.
    const page = await signInWithin(context, uniqueLogin("clip-lan"));
    const errors = collectPageErrors(page);
    expect(await page.evaluate(() => typeof navigator.clipboard)).toBe("undefined");

    const id = await createDocument(page, "# Clipboard\n\nOn the LAN.\n", "Clipboard");
    await openDocument(page, id);

    // 1. Share → Copy link.
    await page.getByTestId("share-button").click();
    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("copy-link")).toHaveText(COPIED_OR_HINT);
    await page.keyboard.press("Escape");

    // 2. The connect dialog: the setup command, then the sentence for the agent.
    const dialog = await openAgentSnippet(page);
    await dialog.getByTestId("agent-setup-copy").click();
    await expect(dialog.getByTestId("agent-setup-copy")).toHaveText(COPIED_OR_HINT);
    // Chromium honours execCommand("copy") inside a click, so this is normally the success branch; record which.
    test.info().annotations.push({ type: "agent-snippet-copy", description: await dialog.getByTestId("agent-setup-copy").innerText() });
    await dialog.getByTestId("agent-invite-copy").click();
    await expect(dialog.getByTestId("agent-invite-copy")).toHaveText(COPIED_OR_HINT);
    await page.keyboard.press("Escape");

    // 3. Settings: the same two buttons in the setup card.
    const setup = await openSettingsSnippet(page);
    await setup.getByTestId("agent-setup-copy").click();
    await expect(setup.getByTestId("agent-setup-copy")).toHaveText(COPIED_OR_HINT);
    await setup.getByTestId("agent-invite-copy").click();
    await expect(setup.getByTestId("agent-invite-copy")).toHaveText(COPIED_OR_HINT);

    expect(errors.length).toBe(0);
    await context.close();
  });

  test("with execCommand refused too, the button shows the hint and the text is selected", async ({ browser }) => {
    const context = await contextWithout(browser, NO_CLIPBOARD_API, NO_EXEC_COMMAND);
    const page = await signInWithin(context, uniqueLogin("clip-none"));
    const errors = collectPageErrors(page);
    const id = await createDocument(page, "# Clipboard\n\nNothing works.\n", "Clipboard none");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);

    const dialog = await openAgentSnippet(page);
    const snippet = dialog.getByTestId("agent-setup-snippet");
    await dialog.getByTestId("agent-setup-copy").click();
    await expect(dialog.getByTestId("agent-setup-copy")).toHaveText(HINT);
    // The command is selected so Ctrl+C finishes the job; the selection is all of it.
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.trim() === (await snippet.innerText()).trim()).toBe(true);
    // The hint is temporary; the button goes back to Copy.
    await expect(dialog.getByTestId("agent-setup-copy")).toHaveText("Copy", { timeout: 5_000 });
    await page.keyboard.press("Escape");

    // Copy link has no text of its own: the URL itself is selected.
    await page.getByTestId("share-button").click();
    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("copy-link")).toHaveText(HINT);
    const link = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(link.trim()).toBe(`${origin}/d/${id}`);

    expect(errors.length).toBe(0);
    await context.close();
  });

  test("with the Clipboard API the copied text is byte-equal to what the dialog shows", async ({ browser }) => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    // Per run: makes a key in the dialog and another in Settings (see the LAN test).
    const page = await signInWithin(context, uniqueLogin("clip-api"));
    const errors = collectPageErrors(page);
    const id = await createDocument(page, "# Clipboard\n\nSecure.\n", "Clipboard api");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);
    // Windows puts CRLF on the system clipboard for every LF written; fold it back before comparing.
    const readClipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");

    await page.getByTestId("share-button").click();
    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("copy-link")).toHaveText("Copied");
    expect((await readClipboard()) === `${origin}/d/${id}`).toBe(true);
    await page.keyboard.press("Escape");

    const dialog = await openAgentSnippet(page);
    const snippet = dialog.getByTestId("agent-setup-snippet");
    // A long command wraps instead of being clipped: the block is no wider than its card.
    const widths = await snippet.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await dialog.getByTestId("agent-setup-copy").click();
    await expect(dialog.getByTestId("agent-setup-copy")).toHaveText("Copied");
    const command = await readClipboard();
    expect(command === (await snippet.innerText()).trim()).toBe(true);
    expect(command).toContain(`${origin}/api/mcp`);
    expect(command).toMatch(/mdk_/);

    await dialog.getByTestId("agent-invite-copy").click();
    await expect(dialog.getByTestId("agent-invite-copy")).toHaveText("Copied");
    const invite = await readClipboard();
    expect(invite === (await dialog.getByTestId("agent-invite-prompt").innerText()).trim()).toBe(true);
    expect(invite).toMatch(new RegExp(`^Sit in the Markdoc document ".*" \\(id ${id}\\): call markdoc_presence active, then loop markdoc_watch`));
    await page.keyboard.press("Escape");

    const setup = await openSettingsSnippet(page);
    await setup.getByTestId("agent-setup-copy").click();
    await expect(setup.getByTestId("agent-setup-copy")).toHaveText("Copied");
    const fromSettings = await readClipboard();
    expect(fromSettings === (await setup.getByTestId("agent-setup-snippet").innerText()).trim()).toBe(true);
    expect(fromSettings).toMatch(/mdk_/);
    await setup.getByTestId("agent-invite-copy").click();
    await expect(setup.getByTestId("agent-invite-copy")).toHaveText("Copied");
    expect(await readClipboard()).toBe("Check Markdoc for requests");

    expect(errors.length).toBe(0);
    await context.close();
  });
});
