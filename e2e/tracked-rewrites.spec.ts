import { test, expect } from "./fixtures";
import { createDocument, ensureCommentsOpen, mintToken, openDocument, signIn, uniqueLogin } from "./helpers";
import { REWRITE_AFTER, REWRITE_AUTHOR, REWRITE_BEFORE, REWRITE_DOCUMENT, REWRITE_RESULT } from "../src/editor/collab/rewrite.test-fixture";

// Synthetic local fixture only. Browser execution is held until separately scheduled.
test.use({ trace: "off", screenshot: "off" });

for (const width of [390, 768, 1280]) {
  for (const decision of ["accept", "reject"] as const) {
    test(`${width}px: one agent paragraph replacement, ${decision}, undo and redo`, async ({ browser, baseURL }) => {
      expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
      const user = await signIn(browser, uniqueLogin(`passage-${width}-${decision}`));
      const page = user.page;
      await page.setViewportSize({ width: 1280, height: 900 });
      const minted = await mintToken(page, REWRITE_AUTHOR);
      let docId: string | undefined;
      try {
        docId = await createDocument(page, REWRITE_DOCUMENT, "Synthetic passage review");
        await openDocument(page, docId);
        await page.setViewportSize({ width, height: 900 });
        const proposal = await page.request.post(`/api/documents/${docId}/suggest`, {
          headers: { Authorization: ["Bearer", minted.token].join(" ") },
          data: { edits: [{ find: REWRITE_BEFORE, replace: REWRITE_AFTER }] },
        });
        expect(proposal.status()).toBe(200);
        const result = await proposal.json() as { suggestions: number; suggestionIds: string[] };
        expect(result.suggestions).toBe(1);
        expect(result.suggestionIds).toHaveLength(1);
        const [id] = result.suggestionIds;

        await ensureCommentsOpen(page);
        await page.getByTestId("comments-tab-suggestions").click();
        const card = page.getByTestId("suggestion-card");
        await expect(card).toHaveCount(1);
        await expect(card).toContainText(REWRITE_AUTHOR);
        await expect(card.getByTestId("suggestion-before")).toHaveText(REWRITE_BEFORE);
        await expect(card.getByTestId("suggestion-after")).toHaveText(REWRITE_AFTER);
        await expect(card.getByTestId("suggestion-accept")).toHaveCount(1);
        await expect(card.getByTestId("suggestion-reject")).toHaveCount(1);
        for (const control of [card, card.getByTestId("suggestion-accept"), card.getByTestId("suggestion-reject")]) {
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        }
        await page.getByRole("button", { name: "Close comments", exact: true }).click();
        for (const surface of ["code", "rich"] as const) {
          const switcher = page.getByTestId(`layout-segment-${surface}`);
          if (await switcher.isVisible()) await switcher.click();
          const pane = page.locator(surface === "code" ? ".cm-content" : ".md-rich");
          await expect(pane).toBeVisible();
          for (const [kind, text] of [["delete", REWRITE_BEFORE], ["insert", REWRITE_AFTER]] as const) {
            const run = pane.locator(`.md-suggest-${kind}`);
            await expect(run).toHaveCount(1);
            await expect(run).toHaveText(text);
            await expect(run).toHaveAttribute("data-highlight-id", id);
          }
        }
        await ensureCommentsOpen(page);
        await page.getByTestId(`suggestion-${decision}`).click();
        const currentText = async () => {
          const response = await page.request.get(`/api/documents/${docId}/content`);
          expect(response.status()).toBe(200);
          return (await response.json() as { content: string }).content;
        };
        const expected = decision === "accept" ? REWRITE_RESULT : REWRITE_DOCUMENT;
        await expect.poll(currentText).toBe(expected);
        await expect(card).toHaveCount(0);
        await page.getByRole("button", { name: "Close comments", exact: true }).click();
        await page.locator(".md-rich p").first().click();
        await page.keyboard.press("ControlOrMeta+z");
        await ensureCommentsOpen(page);
        await page.getByTestId("comments-tab-suggestions").click();
        await expect(card).toHaveCount(1);
        await expect(card).toHaveAttribute("data-suggestion-id", id);
        await page.getByRole("button", { name: "Close comments", exact: true }).click();
        await page.locator(".md-rich p").first().click();
        await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
        await expect.poll(currentText).toBe(expected);
      } finally {
        if (docId) await page.request.delete(`/api/documents/${docId}?permanent=1`);
        await minted.revoke();
        await user.context.close();
      }
    });
  }
}
