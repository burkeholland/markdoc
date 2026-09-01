import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, codeText, focusCodeEnd, pmSelectionSynced } from "./helpers";

const BLOCKS = Array.from({ length: 180 }, (_, index) => {
  const number = index + 1;
  const anchor = `anchor-${String(number).padStart(3, "0")}`;
  const prose = `${"long document text ".repeat(8)}`;
  if (number === 45) return `## Heading ${anchor} ${prose}`;
  if (number === 135) return `- List item ${anchor} ${prose}`;
  if (number === 160) return `| Left | Right |\n| --- | --- |\n| Table cell ${anchor} ${prose} | Other |`;
  return `Paragraph ${anchor} ${prose}`;
});
const DOCUMENT = ["# Undo scroll fixture", ...BLOCKS].join("\n\n") + "\n";

type Surface = "rich" | "code";
type Trigger = "keyboard" | "toolbar";

interface ViewportSnapshot {
  windowY: number;
  shell: number;
  rich: number;
  proseMirror: number;
  code: number;
  targetTop: number;
  targetBottom: number;
  paneHeight: number;
  active: string;
  selectionOffset: number | null;
  sourceOffset: number | null;
  richPath: string;
}

async function snapshot(page: Page, surface: Surface, targetText: string): Promise<ViewportSnapshot> {
  return page.evaluate(
    ({ owner, targetText }) => {
      const rich = document.querySelector<HTMLElement>('[data-testid="rich-column"] .overflow-y-auto')!;
      const code = document.querySelector<HTMLElement>(".cm-scroller")!;
      const candidates =
        owner === "rich"
          ? Array.from(document.querySelectorAll<HTMLElement>(".md-rich h1, .md-rich h2, .md-rich h3, .md-rich p, .md-rich td, .md-rich th"))
          : Array.from(document.querySelectorAll<HTMLElement>(".cm-line"));
      const target = candidates.find((element) => element.textContent?.includes(targetText));
      if (!target) throw new Error(`visible target not found: ${targetText}`);
      const pane = owner === "rich" ? rich : code;
      const paneRect = pane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const pm = document.querySelector<HTMLElement>(".ProseMirror")!;
      const shell = document.querySelector<HTMLElement>("#editor-main")!;
      const active = document.activeElement as HTMLElement | null;
      const richView = (window as unknown as { __markdocRichView: { state: { selection: { head: number } } } }).__markdocRichView;
      const session = (
        window as unknown as {
          __markdocSession: {
            localCursor: { rich: number | null; code: number | null };
          };
        }
      ).__markdocSession;
      const path: string[] = [];
      if (owner === "rich") {
        const node = document.getSelection()?.anchorNode ?? null;
        for (let element = node instanceof Element ? node : node?.parentElement; element && !element.classList.contains("md-rich"); element = element.parentElement) {
          path.push(element.tagName.toLowerCase());
        }
      }
      return {
        windowY: window.scrollY,
        shell: shell.scrollTop,
        rich: rich.scrollTop,
        proseMirror: pm.scrollTop,
        code: code.scrollTop,
        targetTop: targetRect.top - paneRect.top,
        targetBottom: targetRect.bottom - paneRect.top,
        paneHeight: paneRect.height,
        active: `${active?.tagName ?? "none"}.${active?.className ?? ""}`,
        selectionOffset: owner === "rich" ? richView.state.selection.head : session.localCursor.code,
        sourceOffset: session.localCursor[owner],
        richPath: path.join(">"),
      };
    },
    { owner: surface, targetText },
  );
}

async function placeRichCaret(page: Page, targetText: string) {
  await page.evaluate((targetText) => {
    const rich = document.querySelector<HTMLElement>('[data-testid="rich-column"] .overflow-y-auto')!;
    const target = Array.from(
      document.querySelectorAll<HTMLElement>(".md-rich h1, .md-rich h2, .md-rich h3, .md-rich p, .md-rich td, .md-rich th"),
    ).find((element) => element.textContent?.includes(targetText));
    if (!target) throw new Error(`rich target not found: ${targetText}`);
    const box = rich.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    rich.scrollTop += rect.top - box.top - box.height * 0.5 + rect.height * 0.5;

    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const offset = node.textContent?.indexOf(targetText) ?? -1;
      if (offset < 0) continue;
      type RichView = {
        state: {
          doc: unknown;
          selection: { constructor: unknown };
          tr: { setSelection(selection: unknown): unknown };
        };
        posAtDOM(node: Node, offset: number): number;
        dispatch(transaction: unknown): void;
        focus(): void;
      };
      const view = (window as unknown as { __markdocRichView: RichView }).__markdocRichView;
      const position = view.posAtDOM(node, offset + targetText.length);
      const Selection = view.state.selection.constructor as { create(doc: unknown, position: number): unknown };
      view.focus();
      view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, position)));
      return;
    }
    throw new Error(`rich target text node not found: ${targetText}`);
  }, targetText);
  await expect.poll(() => pmSelectionSynced(page)).toBe(true);
  await expect.poll(() => snapshot(page, "rich", targetText).then((value) => value.sourceOffset)).not.toBeNull();
}

async function placeSourceCaret(page: Page, targetText: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("find-input")).toBeFocused();
  await page.getByTestId("find-input").fill(targetText);
  await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => snapshot(page, "code", targetText).then((value) => value.sourceOffset)).not.toBeNull();
}

async function setLayout(page: Page, layout: "split" | "rich" | "code") {
  const labels = {
    split: /Split/,
    rich: /Preview only/,
    code: /Code only/,
  };
  await page.getByTestId("layout-menu").click();
  await page.getByRole("menuitemradio", { name: labels[layout] }).click();
  await expect(page.getByTestId("rich-column")).toBeVisible({ visible: layout !== "code" });
  await expect(page.getByTestId("code-column")).toBeVisible({ visible: layout !== "rich" });
}

function expectStableViewport(before: ViewportSnapshot, after: ViewportSnapshot) {
  const metrics = JSON.stringify({ before, after });
  expect(Math.abs(after.rich - before.rich), metrics).toBeLessThanOrEqual(2);
  expect(Math.abs(after.code - before.code), metrics).toBeLessThanOrEqual(2);
  expect(Math.abs(after.proseMirror - before.proseMirror), metrics).toBeLessThanOrEqual(2);
  expect(Math.abs(after.targetTop - before.targetTop), metrics).toBeLessThanOrEqual(2);
  expect(after.windowY, metrics).toBe(before.windowY);
  expect(after.shell, metrics).toBe(before.shell);
}

async function exerciseUndo(page: Page, surface: Surface, targetText: string, trigger: Trigger, token: string) {
  if (surface === "rich") await placeRichCaret(page, targetText);
  else await placeSourceCaret(page, targetText);
  await page.waitForTimeout(300);

  const url = page.url();
  const beforeContent = await codeText(page);
  const before = await snapshot(page, surface, targetText);
  await page.keyboard.type(token);
  await expect.poll(() => codeText(page)).not.toBe(beforeContent);
  const editedContent = await codeText(page);
  const edited = await snapshot(page, surface, targetText);
  await page.waitForTimeout(500);

  if (trigger === "keyboard") await page.keyboard.press("Control+z");
  else await page.getByTestId("tb-undo").click();
  await expect.poll(() => codeText(page)).toBe(beforeContent);
  await page.waitForTimeout(200);
  const undone = await snapshot(page, surface, targetText);
  expectStableViewport(before, undone);
  expect(undone.selectionOffset, JSON.stringify({ before, undone })).toBe(before.selectionOffset);
  expect(undone.sourceOffset, JSON.stringify({ before, undone })).toBe(before.sourceOffset);
  expect(undone.richPath, JSON.stringify({ before, undone })).toBe(before.richPath);
  expect(undone.active).toContain(surface === "rich" ? "ProseMirror" : "cm-content");
  expect(page.url()).toBe(url);

  if (trigger === "keyboard") await page.keyboard.press("Control+y");
  else await page.getByTestId("tb-redo").click();
  await expect.poll(() => codeText(page)).toBe(editedContent);
  await page.waitForTimeout(200);
  const redone = await snapshot(page, surface, targetText);
  expectStableViewport(before, redone);
  expect(redone.selectionOffset, JSON.stringify({ edited, redone })).toBe(edited.selectionOffset);
  expect(redone.sourceOffset, JSON.stringify({ edited, redone })).toBe(edited.sourceOffset);
  expect(redone.active).toContain(surface === "rich" ? "ProseMirror" : "cm-content");
  expect(page.url()).toBe(url);

  return { before, undone, redone };
}

for (const layout of ["split", "rich", "code"] as const) {
  test(`undo and redo preserve 25%, 75%, and final positions in ${layout} layout`, async ({ browser }, testInfo) => {
    const user = await signIn(browser, `undo-scroll-${layout}-${Date.now().toString(36)}`);
    const { page } = user;
    await page.setViewportSize({ width: 1280, height: 800 });
    const id = await createDocument(page, DOCUMENT, `Undo scroll ${layout} fixture`);
    await openDocument(page, id);
    if (layout !== "split") await setLayout(page, layout);

    // A stale source selection at the top was the trigger: y-codemirror revealed it during a Rich
    // undo, then synchronized scrolling drove both panes from 75% to the top.
    if (layout === "split") await page.locator(".cm-content").click({ position: { x: 30, y: 10 } });
    const surface: Surface = layout === "code" ? "code" : "rich";
    const samples: Array<{ target: string; trigger: Trigger; metrics: Awaited<ReturnType<typeof exerciseUndo>> }> = [];
    for (const target of ["anchor-045", "anchor-135", "anchor-180"]) {
      for (const trigger of ["keyboard", "toolbar"] as const) {
        const metrics = await exerciseUndo(page, surface, target, trigger, `${layout[0]}${target.slice(-3)}${trigger[0]}`);
        if (target === "anchor-135") samples.push({ target, trigger, metrics });
      }
    }
    if (layout === "rich") await exerciseUndo(page, "rich", "anchor-160", "toolbar", "CELL");

    console.log(`[undo-scroll] ${layout} representative metrics ${JSON.stringify(samples)}`);
    if (layout === "split") {
      await testInfo.attach("split-deep-document-undo.png", { body: await page.screenshot(), contentType: "image/png" });
    }
    await user.context.close();
  });
}

test("mobile deep undo keeps the edited list item visible", async ({ browser }, testInfo) => {
  const user = await signIn(browser, `undo-scroll-phone-${Date.now().toString(36)}`);
  const { page } = user;
  const id = await createDocument(page, DOCUMENT, "Mobile undo scroll fixture");
  await openDocument(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("code-column")).toBeHidden();

  const metrics = await exerciseUndo(page, "rich", "anchor-135", "keyboard", "PHONE");
  expect(metrics.undone.targetBottom).toBeGreaterThan(0);
  expect(metrics.undone.targetTop).toBeLessThan(metrics.undone.paneHeight);
  await testInfo.attach("mobile-deep-document-undo.png", { body: await page.screenshot(), contentType: "image/png" });
  await user.context.close();
});

test("a peer update does not steal focus, selection, or either local viewport", async ({ browser }) => {
  const owner = await signIn(browser, `undo-scroll-owner-${Date.now().toString(36)}`);
  const peer = await signIn(browser, `undo-scroll-peer-${Date.now().toString(36)}`);
  const id = await createDocument(owner.page, DOCUMENT, "Remote undo scroll fixture");
  await shareWith(owner.page, id, peer.login, "editor");
  await openDocument(owner.page, id);
  await openDocument(peer.page, id);

  await placeRichCaret(owner.page, "anchor-135");
  await owner.page.waitForTimeout(300);
  const before = await snapshot(owner.page, "rich", "anchor-135");
  await focusCodeEnd(peer.page);
  await peer.page.keyboard.type("\n\nRemote update once.");
  await expect.poll(() => codeText(owner.page)).toContain("Remote update once.");
  await owner.page.waitForTimeout(200);
  const after = await snapshot(owner.page, "rich", "anchor-135");

  expectStableViewport(before, after);
  expect(after.active).toContain("ProseMirror");
  expect(after.selectionOffset).toBe(before.selectionOffset);
  expect(after.sourceOffset).toBe(before.sourceOffset);
  expect((await codeText(owner.page)).match(/Remote update once\./g)).toHaveLength(1);
  await owner.context.close();
  await peer.context.close();
});
