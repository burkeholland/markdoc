import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export interface User {
  context: BrowserContext;
  page: Page;
  login: string;
}

/** Sign in with the development login and land on the dashboard. */
export async function signIn(browser: Browser, login: string): Promise<User> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForLoadState("networkidle");
  return { context, page, login };
}

/** Create a document through the API (faster and more reliable than clicking through). */
export async function createDocument(page: Page, content: string, title?: string): Promise<string> {
  const res = await page.request.post("/api/documents", { data: { content, title } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

export async function openDocument(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".md-rich")).toBeVisible();
}

export async function shareWith(page: Page, docId: string, login: string, role: "editor" | "commenter" | "viewer") {
  const res = await page.request.post(`/api/documents/${docId}/collaborators`, { data: { login, role } });
  expect(res.ok()).toBeTruthy();
}

/** The shared Markdown text (what both panes render), read from the live session. */
export const codeText = (page: Page) =>
  page.evaluate(() => (window as unknown as { __markdocSession: { ytext: { toString(): string } } }).__markdocSession.ytext.toString());

/** Visible text of the rich pane without remote caret labels. */
export const richText = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector(".md-rich");
    if (!root) return "";
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".md-remote-caret").forEach((n) => n.remove());
    clone.style.position = "absolute";
    clone.style.left = "-99999px";
    document.body.appendChild(clone);
    const text = clone.innerText;
    clone.remove();
    return text;
  });

/** Place the caret at the end of the rich editor's document. */
export async function focusRichEnd(page: Page) {
  const rich = page.locator(".md-rich");
  await rich.click();
  await page.keyboard.press("Control+End");
}

export async function focusCodeEnd(page: Page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
}

export async function selectTextInRich(page: Page, text: string) {
  await page.evaluate((needle) => {
    const root = document.querySelector(".md-rich")!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const idx = node.textContent!.indexOf(needle);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        (root as HTMLElement).focus();
        return;
      }
    }
    throw new Error(`text not found: ${needle}`);
  }, text);
  // Let ProseMirror pick up the DOM selection.
  await page.waitForTimeout(150);
}


/** Open the comments side panel if it is not already visible. */
export async function ensureCommentsOpen(page: Page) {
  if ((await page.getByTestId("comments-panel").count()) === 0) {
    await page.getByTestId("comments-toggle").click();
  }
  await expect(page.getByTestId("comments-panel")).toBeVisible();
}
