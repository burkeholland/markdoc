import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createDocument, devLogin, focusCodeEnd, openDocument, uniqueLogin } from "./helpers";

async function labelFitsPane(label: Locator): Promise<boolean> {
  const bounds = await label.evaluate((element) => {
    const labelRect = element.getBoundingClientRect();
    let pane = element.parentElement;
    while (pane) {
      if (["auto", "clip", "hidden", "scroll"].includes(getComputedStyle(pane).overflowX)) break;
      pane = pane.parentElement;
    }
    const clip = pane ?? element.ownerDocument.documentElement;
    const paneRect = clip.getBoundingClientRect();
    const paneLeft = paneRect.left + clip.clientLeft;
    const paneRight = paneLeft + clip.clientWidth;
    return { labelLeft: labelRect.left, labelRight: labelRect.right, paneLeft, paneRight };
  });
  return bounds.labelLeft >= bounds.paneLeft - 0.5 && bounds.labelRight <= bounds.paneRight + 0.5;
}

test("[2506] remote cursor labels stay within both editor panes at 1280x720", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const firstTab = await context.newPage();
    const login = uniqueLogin("cursor-labels");
    await devLogin(firstTab, login);
    const documentId = await createDocument(firstTab, "Realtime collaboration verified from tab B", "Welcome to Markdoc");

    const secondTab = await context.newPage();
    await openDocument(firstTab, documentId);
    await openDocument(secondTab, documentId);
    await focusCodeEnd(secondTab);

    const richLabel = firstTab.locator('[data-testid="rich-pane"] .md-remote-caret-label').first();
    const codeLabel = firstTab.locator('[data-testid="code-pane"] .cm-ySelectionInfo').first();
    await expect(richLabel).toContainText("you in another tab");
    await expect(codeLabel).toContainText("you in another tab");
    await expect.poll(() => labelFitsPane(richLabel), "preview cursor label should fit its scroll pane").toBe(true);
    await expect.poll(() => labelFitsPane(codeLabel), "source cursor label should fit its scroll pane").toBe(true);

    await firstTab.screenshot({ path: testInfo.outputPath("cursor-labels-1280x720.png") });
  } finally {
    await context.close();
  }
});
