import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { createDocument, focusRichEnd, openDocument, selectTextInRich, signIn } from "./helpers";

const MISSPELLING = "qzxvblort";

async function wordPoint(page: Page, word: string) {
  return page.locator(".md-rich").evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf(needle) ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`word not found: ${needle}`);
  }, word);
}

async function activeCommentId(page: Page) {
  return page.evaluate(() => (window as unknown as { __markdocSession: { activeCommentId: string | null } }).__markdocSession.activeCommentId);
}

test("spelling interactions stay in the editor while an exact comment highlight opens its thread", async ({ browser }) => {
  const user = await signIn(browser, "spelling-click");
  const { page } = user;
  const documentId = await createDocument(
    page,
    "# Spelling clicks\n\nA safe paragraph for a comment. A remote landing target.",
    "Spelling clicks",
  );
  await openDocument(page, documentId);
  await expect(page.locator(".md-rich")).toHaveAttribute("spellcheck", "true");

  await focusRichEnd(page);
  await page.keyboard.type(` ${MISSPELLING}`);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const point = await wordPoint(page, MISSPELLING);

  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rich = document.querySelector(".md-rich");
        const selection = document.getSelection();
        return Boolean(rich?.contains(selection?.anchorNode ?? null) && selection?.isCollapsed && document.activeElement === rich);
      }),
    )
    .toBe(true);

  await page.waitForTimeout(600);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().trim())).toBe(MISSPELLING);

  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);
  await page.keyboard.down("Control");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Control");
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);

  await selectTextInRich(page, "safe paragraph");
  await page.getByTestId("tb-comment").click();
  await page.getByTestId("comment-composer").fill("This is the exact thread.");
  await page.getByTestId("comment-submit").click();
  const thread = page.getByTestId("comment-thread").filter({ hasText: "This is the exact thread." });
  await expect(thread).toBeVisible();
  const threadId = await thread.getAttribute("data-thread-id");
  expect(threadId).toBeTruthy();
  const landingResponse = await page.request.post(`/api/documents/${documentId}/comments`, {
    data: { action: "add", quote: "remote landing target", body: "Temporary landing anchor." },
  });
  expect(landingResponse.ok()).toBeTruthy();
  const landingId = ((await landingResponse.json()) as { id: string }).id;
  await expect(page.locator(`.md-rich [data-highlight-id="${landingId}"]`)).toBeVisible();

  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("comments-panel")).toBeVisible();
  await expect.poll(() => activeCommentId(page)).toBe(threadId);

  await page.getByTestId("comments-toggle").click();
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __markdocSession: { setActiveComment(id: string | null): void } }).__markdocSession.setActiveComment(null));
  await page.locator(`.md-rich [data-highlight-id="${threadId}"]`).evaluate(
    (node, ids) => {
      type SharedMap = { get(key: string): unknown; set(key: string, value: unknown): void };
      const session = (
        window as unknown as {
          __markdocSession: {
            comments: { ymap: { get(id: string): SharedMap | undefined; delete(id: string): void } };
          };
        }
      ).__markdocSession;
      const stale = session.comments.ymap.get(ids.threadId);
      const landing = session.comments.ymap.get(ids.landingId);
      if (!stale || !landing) throw new Error("comment anchors were not available");
      const rect = node.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      node.dispatchEvent(new MouseEvent("mousedown", init));
      stale.set("anchor", landing.get("anchor"));
      stale.set("quote", landing.get("quote"));
      session.comments.ymap.delete(ids.landingId);
      node.dispatchEvent(new MouseEvent("mouseup", init));
      node.dispatchEvent(new MouseEvent("click", init));
    },
    { threadId: threadId!, landingId },
  );
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);
  await expect.poll(() => activeCommentId(page)).toBeNull();

  const movedHighlight = page.locator(`.md-rich [data-highlight-id="${threadId}"]`);
  await expect(movedHighlight).toContainText("remote landing target");
  await movedHighlight.click();
  await expect(page.getByTestId("comments-panel")).toBeVisible();
  await expect.poll(() => activeCommentId(page)).toBe(threadId);
  await expect(thread).toHaveClass(/border-accent/);

  await user.context.close();
});
