import { test, expect, type Page } from "@playwright/test";
import { caretPath, clickEdgeOf, codeText, createDocument, openDocument, selectTextInRich, shareWith, signIn } from "./helpers";

const INITIAL = ["Paragraph above.", "", "- first bullet text", "- second bullet text", "", "Paragraph below.", ""].join("\n");

const VIEWPORTS = [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
] as const;

async function showSurface(page: Page, surface: "rich" | "code") {
  const pane = page.getByTestId(surface === "rich" ? "rich-pane" : "code-pane");
  if (!(await pane.isVisible())) {
    await page.getByTestId(`layout-segment-${surface}`).click();
  }
  await expect(pane).toBeVisible();
}

async function placeCodeCaret(page: Page, text: string, column: number) {
  const line = page.locator(".cm-line").filter({ hasText: text }).first();
  await expect(line).toBeVisible();
  await line.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < column; i++) await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __markdocSession: { localCursor: { code: number | null } } }).__markdocSession.localCursor.code,
      ),
    )
    .toBe(INITIAL.indexOf("first bullet text"));
}

async function observePeerStates(page: Page) {
  await page.evaluate(() => {
    type TaskWindow = Window & {
      __markdocSession: { ytext: { observe(cb: () => void): void; toString(): string } };
      __listBackspaceStates?: string[];
    };
    const taskWindow = window as unknown as TaskWindow;
    taskWindow.__listBackspaceStates = [];
    const text = taskWindow.__markdocSession.ytext;
    text.observe(() => taskWindow.__listBackspaceStates!.push(text.toString()));
  });
}

const peerStates = (page: Page) =>
  page.evaluate(() => (window as Window & { __listBackspaceStates?: string[] }).__listBackspaceStates ?? []);

for (const [viewportName, viewport] of VIEWPORTS) {
  for (const surface of ["rich", "code"] as const) {
    test(`${surface} first-item Backspace preserves text, syncs once, and undoes one press at a time on ${viewportName}`, async ({
      browser,
    }, testInfo) => {
      const owner = await signIn(browser, `list-backspace-${surface}-${viewportName}-owner`);
      const peer = await signIn(browser, `list-backspace-${surface}-${viewportName}-peer`);
      try {
        const id = await createDocument(owner.page, INITIAL, `List Backspace ${surface} ${viewportName}`);
        await shareWith(owner.page, id, peer.login, "editor");
        await openDocument(owner.page, id);
        await openDocument(peer.page, id);
        await owner.page.setViewportSize(viewport);
        await peer.page.setViewportSize(viewport);
        await showSurface(owner.page, surface);
        await observePeerStates(peer.page);

        if (surface === "rich") {
          await clickEdgeOf(owner.page, "ul li:first-child p", "start");
        } else {
          await placeCodeCaret(owner.page, "- first bullet text", 2);
        }
        if (viewportName === "desktop") {
          await owner.page.screenshot({ path: testInfo.outputPath(`${surface}-list-backspace-before.png`), fullPage: true });
        }

        const states =
          surface === "rich"
            ? [
                ["Paragraph above.", "", "first bullet text", "", "- second bullet text", "", "Paragraph below.", ""].join("\n"),
                ["Paragraph above.first bullet text", "", "- second bullet text", "", "Paragraph below.", ""].join("\n"),
                ["Paragraph abovefirst bullet text", "", "- second bullet text", "", "Paragraph below.", ""].join("\n"),
              ]
            : [
                ["Paragraph above.", "", "first bullet text", "- second bullet text", "", "Paragraph below.", ""].join("\n"),
                ["Paragraph above.", "first bullet text", "- second bullet text", "", "Paragraph below.", ""].join("\n"),
                ["Paragraph above.first bullet text", "- second bullet text", "", "Paragraph below.", ""].join("\n"),
              ];

        for (const expected of states) {
          await owner.page.keyboard.press("Backspace");
          await expect.poll(() => codeText(owner.page)).toBe(expected);
          await expect.poll(() => codeText(peer.page)).toBe(expected);
        }
        expect(await peerStates(peer.page)).toEqual(states);
        expect(states[2].match(/^- /gm)).toHaveLength(1);

        for (const expected of [states[1], states[0], INITIAL]) {
          await owner.page.keyboard.press("Control+z");
          await expect.poll(() => codeText(owner.page)).toBe(expected);
        }
        for (const expected of states) {
          await owner.page.keyboard.press("Backspace");
          await expect.poll(() => codeText(owner.page)).toBe(expected);
        }

        await expect(owner.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
        await owner.page.reload();
        await expect(owner.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
        await expect.poll(() => codeText(owner.page)).toBe(states[2]);
        if (viewportName === "desktop") {
          await owner.page.screenshot({ path: testInfo.outputPath(`${surface}-list-backspace.png`), fullPage: true });
        }
      } finally {
        await owner.context.close();
        await peer.context.close();
      }
    });
  }
}

test("Rich Backspace removes a selected later item without resurrecting its bullet", async ({ browser }, testInfo) => {
  const owner = await signIn(browser, "list-backspace-selected-owner");
  const peer = await signIn(browser, "list-backspace-selected-peer");
  try {
    await owner.page.setViewportSize({ width: 1280, height: 800 });
    const id = await createDocument(owner.page, INITIAL, "Selected list item Backspace");
    await shareWith(owner.page, id, peer.login, "editor");
    await openDocument(owner.page, id);
    await openDocument(peer.page, id);
    await selectTextInRich(owner.page, "second bullet text");

    await owner.page.keyboard.press("Backspace");
    await expect.poll(() => codeText(owner.page)).toBe(INITIAL.replace("second bullet text", ""));
    await owner.page.keyboard.press("Backspace");
    const removed = ["Paragraph above.", "", "- first bullet text", "", "Paragraph below.", ""].join("\n");
    await expect.poll(() => codeText(owner.page)).toBe(removed);
    await owner.page.keyboard.press("Backspace");
    const final = removed.replace("first bullet text", "first bullet tex");
    await expect.poll(() => codeText(owner.page)).toBe(final);
    await expect.poll(() => codeText(peer.page)).toBe(final);
    await expect.poll(() => caretPath(owner.page)).toMatch(/li>.*p$/);
    await owner.page.screenshot({ path: testInfo.outputPath("selected-item-no-resurrection.png"), fullPage: true });
  } finally {
    await owner.context.close();
    await peer.context.close();
  }
});
