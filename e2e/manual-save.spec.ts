import { test, expect } from "./fixtures";
import type { Page, WebSocket } from "@playwright/test";
import { codeText, createDocument, focusRichEnd, openDocument, signIn } from "./helpers";
import { CONTENT_AUTOSAVE_IDLE_MS } from "../src/lib/document-persistence";

/**
 * #2217: a real click on Save, or Enter on the focused Save button, while the header says
 * "Unsaved changes" must send `document-persistence-flush` at once. Autosave runs on the server, so the
 * client sends that frame only for a manual save; before the fix no frame went out and the label turned
 * "Saved" only when the server's idle autosave ran.
 */

const CONTENT = "# Manual save\n\nA paragraph.\n";
const FLUSH = "document-persistence-flush";

/** Records when (runner Date.now()) the page sends each flush frame. Attach before the document opens its socket. */
function recordFlushFrames(page: Page) {
  const sent: number[] = [];
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framesent", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      if (text.includes(FLUSH)) sent.push(Date.now());
    });
  });
  return sent;
}

async function typeUnsavedEdit(page: Page, text: string) {
  await focusRichEnd(page);
  await page.keyboard.type(text, { delay: 30 });
  // Click while the edit is still unsaved: well inside the server's idle autosave window.
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "pending", { timeout: 1_000 });
}

async function expectManualFlush(page: Page, docId: string, sent: number[], activatedAt: number, typed: string) {
  // The flush must leave right after the activation, long before autosave (CONTENT_AUTOSAVE_IDLE_MS
  // after the last key) could have saved instead.
  await expect.poll(() => sent.length, { timeout: CONTENT_AUTOSAVE_IDLE_MS / 2 }).toBeGreaterThan(0);
  expect(sent[0] - activatedAt).toBeLessThan(CONTENT_AUTOSAVE_IDLE_MS / 2);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  await expect(page.getByRole("button", { name: "Save document", exact: true })).toBeEnabled();
  await openDocument(page, docId);
  await expect.poll(() => codeText(page)).toContain(typed);
}

test("clicking Save while there are unsaved changes flushes at once", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Manual save: click");
    const sent = recordFlushFrames(alice.page);
    await openDocument(alice.page, docId);
    await typeUnsavedEdit(alice.page, " click-save");
    expect(sent).toHaveLength(0);

    const save = alice.page.getByRole("button", { name: "Save document", exact: true });
    const box = await save.boundingBox();
    if (!box) throw new Error("Save button has no box");
    const activatedAt = Date.now();
    await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expectManualFlush(alice.page, docId, sent, activatedAt, " click-save");
  } finally {
    await alice.context.close();
  }
});

test("pressing Enter on the focused Save button while there are unsaved changes flushes at once", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Manual save: Enter");
    const sent = recordFlushFrames(alice.page);
    await openDocument(alice.page, docId);
    await typeUnsavedEdit(alice.page, " enter-save");
    expect(sent).toHaveLength(0);

    const save = alice.page.getByRole("button", { name: "Save document", exact: true });
    await save.focus();
    await expect(save).toBeFocused();
    const activatedAt = Date.now();
    await alice.page.keyboard.press("Enter");

    await expectManualFlush(alice.page, docId, sent, activatedAt, " enter-save");
  } finally {
    await alice.context.close();
  }
});
