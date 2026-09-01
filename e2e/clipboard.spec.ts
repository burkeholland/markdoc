import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createDocument, devLogin, openDocument, uniqueLogin } from "./helpers";

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

/** /settings, hydrated: the tokens list has loaded, so the form's handlers are attached. */
async function openSettings(page: Page) {
  await page.goto("/settings");
  await expect(page.getByTestId("token-name")).toBeVisible();
  await expect(page.getByText("Loading…")).toHaveCount(0);
}

test.describe("copy buttons without navigator.clipboard (plain-HTTP LAN origin)", () => {
  test("Share agent card, Copy link and the settings token card copy without a page error", async ({ browser }) => {
    const context = await contextWithout(browser, NO_CLIPBOARD_API);
    // Per run: step 3 mints a token with the default name and never revokes it; names are unique per user (409).
    const page = await signInWithin(context, uniqueLogin("clip-lan"));
    const errors = collectPageErrors(page);
    expect(await page.evaluate(() => typeof navigator.clipboard)).toBe("undefined");

    const id = await createDocument(page, "# Clipboard\n\nOn the LAN.\n", "Clipboard");
    await openDocument(page, id);

    // 1. Share → Collaborate card (collapsed by default) → Copy.
    await page.getByTestId("share-button").click();
    await page.getByTestId("share-agent-toggle").click();
    await expect(page.getByTestId("share-agent-config")).toContainText('"type": "http"');
    await page.getByTestId("share-agent-copy").click();
    await expect(page.getByTestId("share-agent-copy")).toHaveText(COPIED_OR_HINT);
    // Chromium honours execCommand("copy") inside a click, so this is normally the success branch; record which.
    test.info().annotations.push({ type: "share-agent-copy", description: await page.getByTestId("share-agent-copy").innerText() });

    // 2. Copy link under the people list.
    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("copy-link")).toHaveText(COPIED_OR_HINT);
    await page.keyboard.press("Escape");

    // 3. Settings → create a token → Copy on the token card, plus the connect card's config.
    await openSettings(page);
    await page.getByTestId("token-create").click();
    await expect(page.getByTestId("token-created")).toBeVisible();
    await page.getByTestId("copy-token-button").click();
    await expect(page.getByTestId("copy-token-button")).toHaveText(COPIED_OR_HINT);
    await page.getByRole("button", { name: "Copy MCP configuration" }).click();
    await expect(page.getByRole("button", { name: "Copy MCP configuration" })).toHaveText(COPIED_OR_HINT);

    expect(errors, errors.join("\n")).toEqual([]);
    await context.close();
  });

  test("with execCommand refused too, the button shows the hint and the text is selected", async ({ browser }) => {
    const context = await contextWithout(browser, NO_CLIPBOARD_API, NO_EXEC_COMMAND);
    const page = await signInWithin(context, "clip-none");
    const errors = collectPageErrors(page);
    const id = await createDocument(page, "# Clipboard\n\nNothing works.\n", "Clipboard none");
    await openDocument(page, id);

    await page.getByTestId("share-button").click();
    await page.getByTestId("share-agent-toggle").click();
    const config = page.getByTestId("share-agent-config");
    await expect(config).toContainText('"type": "http"');
    await page.getByTestId("share-agent-copy").click();
    await expect(page.getByTestId("share-agent-copy")).toHaveText(HINT);
    // The <pre> is selected so Ctrl+C finishes the job; the selection is the whole config.
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.trim()).toBe((await config.innerText()).trim());
    // The hint is temporary; the button goes back to Copy.
    await expect(page.getByTestId("share-agent-copy")).toHaveText("Copy", { timeout: 5_000 });

    // Copy link has no text of its own: the URL appears in a selected field.
    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("copy-link")).toHaveText(HINT);
    const field = page.getByTestId("copy-link-fallback");
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(new RegExp(`/d/${id}$`));
    await expect(field).toBeFocused();
    expect(await field.evaluate((el: HTMLInputElement) => (el.selectionEnd ?? 0) - (el.selectionStart ?? 0))).toBe((await field.inputValue()).length);

    expect(errors, errors.join("\n")).toEqual([]);
    await context.close();
  });

  test("with the Clipboard API the copied text is byte-equal to what the card shows", async ({ browser }) => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    // Per run: mints a token with the default name too (see the LAN test).
    const page = await signInWithin(context, uniqueLogin("clip-api"));
    const errors = collectPageErrors(page);
    const id = await createDocument(page, "# Clipboard\n\nSecure.\n", "Clipboard api");
    await openDocument(page, id);
    const origin = await page.evaluate(() => window.location.origin);
    // Windows puts CRLF on the system clipboard for every LF written; fold it back before comparing.
    const readClipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");

    await page.getByTestId("share-button").click();
    await page.getByTestId("share-agent-toggle").click();
    const config = page.getByTestId("share-agent-config");
    await expect(config).toContainText('"type": "http"');
    // The Bearer line wraps instead of being clipped: the <pre> is no wider than its card.
    const widths = await config.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await page.getByTestId("share-agent-copy").click();
    await expect(page.getByTestId("share-agent-copy")).toHaveText("Copied");
    expect(await readClipboard()).toBe((await config.innerText()).trim());

    await page.getByTestId("copy-link").click();
    await expect(page.getByTestId("copy-link")).toHaveText("Copied");
    expect(await readClipboard()).toBe(`${origin}/d/${id}`);
    await page.keyboard.press("Escape");

    await openSettings(page);
    await page.getByTestId("token-create").click();
    await expect(page.getByTestId("token-created")).toBeVisible();
    await page.getByTestId("copy-token-button").click();
    await expect(page.getByTestId("copy-token-button")).toHaveText("Copied");
    const token = (await page.getByTestId("copy-token").innerText()).trim();
    expect(token.startsWith("mdk_")).toBeTruthy();
    expect(await readClipboard()).toBe(token);

    expect(errors, errors.join("\n")).toEqual([]);
    await context.close();
  });
});
