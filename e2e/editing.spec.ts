import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, codeText, richText, focusRichEnd, focusCodeEnd, selectTextInRich } from "./helpers";

const SAMPLE = `# Project Notes

Welcome to the **Project Notes** document.

## Goals

- Deliver value to our users
- Maintain code quality

## Tasks

- [x] Define project scope
- [ ] Write documentation
`;

test.describe("single user editing", () => {
  test("dashboard creates a document and the editor renders both surfaces", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const { page } = user;
    await page.getByTestId("new-document").click();
    await page.waitForURL(/\/d\//);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.getByTestId("outline")).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("# Untitled");
    await expect(page.locator(".md-rich h1")).toHaveText("Untitled");
    await expect(page.getByTestId("word-count")).toContainText("words");
    await user.context.close();
  });

  test("typing in the rich pane updates the Markdown source", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.type(" Ship it.");
    await expect.poll(() => codeText(page)).toContain("- [ ] Write documentation Ship it.");

    // Markdown shortcut in the rich pane: "## " makes a heading.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## Decisions");
    await expect.poll(() => codeText(page)).toContain("## Decisions");
    await expect(page.locator(".md-rich h2").last()).toHaveText("Decisions");
    await expect(page.getByTestId("outline")).toContainText("Decisions");
    await user.context.close();
  });

  test("typing in the code pane updates the rich preview", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await focusCodeEnd(page);
    await page.keyboard.type("\n\n> A quote from the source");
    await expect(page.locator(".md-rich blockquote")).toContainText("A quote from the source");

    // Enter continues the quote (`> `); Enter again on the empty marker line exits it.
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toMatch(/> A quote from the source\n> ?$/);
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toMatch(/> A quote from the source\n$/);
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toMatch(/> A quote from the source\n\n$/);

    await page.keyboard.type("| a | b |\n|---|---|\n| 1 | 2 |");
    await expect.poll(() => codeText(page)).not.toMatch(/^> \|/m);
    await expect(page.locator(".md-rich table")).toBeVisible();
    await expect(page.locator(".md-rich td").last()).toHaveText("2");
    await user.context.close();
  });

  test("toolbar applies formatting on both surfaces and undo works", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Plain paragraph here.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await selectTextInRich(page, "paragraph");
    await page.getByTestId("tb-bold").click();
    await expect.poll(() => codeText(page)).toContain("Plain **paragraph** here.");
    await expect(page.locator(".md-rich strong")).toHaveText("paragraph");

    // Undo through the shared history.
    await page.getByTestId("tb-undo").click();
    await expect.poll(() => codeText(page)).not.toContain("**");

    // Heading from the toolbar applies to the rich pane's current block.
    await page.locator(".md-rich p").first().click();
    await page.getByTestId("heading-menu").click();
    await page.getByRole("menuitemradio", { name: "Heading 2" }).click();
    await expect.poll(() => codeText(page)).toContain("## Plain paragraph here.");

    // Toolbar on the code pane wraps the word at the cursor.
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.getByTestId("tb-italic").click();
    await expect.poll(() => codeText(page)).toMatch(/\*here\*/);
    await user.context.close();
  });

  test("task checkboxes toggle from the preview", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "- [ ] Buy milk\n- [x] Call mom\n");
    await openDocument(user.page, id);
    const { page } = user;
    await page.locator(".md-task-item").first().locator(".md-task-checkbox").click();
    await expect.poll(() => codeText(page)).toContain("- [x] Buy milk");
    await page.locator(".md-task-item").nth(1).locator(".md-task-checkbox").click();
    await expect.poll(() => codeText(page)).toContain("- [ ] Call mom");
    await user.context.close();
  });

  test("selection bubble formats text and starts a comment", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Select some of these words please.\n");
    await openDocument(user.page, id);
    const { page } = user;
    await expect(page.getByTestId("selection-bubble")).toHaveCount(0);
    await selectTextInRich(page, "these words");
    await expect(page.getByTestId("selection-bubble")).toBeVisible();
    await page.getByTestId("selection-bubble").getByRole("button", { name: "Bold" }).click();
    await expect.poll(() => codeText(page)).toContain("Select some of **these words** please.");
    await page.getByTestId("selection-bubble").getByRole("button", { name: "Comment" }).click();
    await expect(page.getByTestId("pending-comment")).toBeVisible();
    await page.getByTestId("comment-composer").fill("Bubble comment");
    await page.getByTestId("comment-submit").click();
    await expect(page.getByTestId("comment-thread")).toContainText("Bubble comment");
    // Collapsing the selection hides the bubble.
    await page.locator(".md-rich p").first().click();
    await expect(page.getByTestId("selection-bubble")).toHaveCount(0);
    await user.context.close();
  });

  test("insert dialogs add links, images and tables", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Read the docs for details.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await selectTextInRich(page, "the docs");
    await page.getByTestId("tb-link").click();
    await page.getByTestId("link-url").fill("example.com/docs");
    await page.getByTestId("link-submit").click();
    await expect.poll(() => codeText(page)).toContain("Read [the docs](https://example.com/docs) for details.");

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await page.getByTestId("tb-image").click();
    await page.getByTestId("image-url").fill("https://example.com/pic.png");
    await page.getByTestId("image-alt").fill("A picture");
    await page.getByTestId("image-submit").click();
    await expect.poll(() => codeText(page)).toContain("![A picture](https://example.com/pic.png)");

    await focusRichEnd(page);
    await page.getByTestId("tb-table").click();
    await page.getByTestId("table-grid").getByRole("button", { name: "2 by 3" }).click();
    await expect.poll(() => codeText(page)).toContain("| Column 1 | Column 2 | Column 3 |");
    await expect(page.locator(".md-rich table")).toBeVisible();
    await user.context.close();
  });

  test("outline lists headings, selects on click and moves focus with arrow keys", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "# First\n\nIntro.\n\n## Second\n\nMore.\n\n## Third\n\nEnd.\n");
    await openDocument(user.page, id);
    const { page } = user;
    const items = page.getByTestId("outline").getByRole("button", { name: /First|Second|Third/ });
    await expect(items).toHaveCount(3);
    await expect(items).toHaveText(["First", "Second", "Third"]);

    // Clicking the third heading reveals it in the code pane and marks it current.
    await items.nth(2).click();
    await expect(page.locator(".cm-activeLine")).toContainText("## Third");
    await expect(items.nth(2)).toHaveAttribute("aria-current", "location");
    await expect(items.nth(0)).not.toHaveAttribute("aria-current", /.+/);

    // Roving tabindex: ArrowDown/ArrowUp/Home/End move focus between items.
    await items.nth(0).focus();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".cm-activeLine")).toContainText("# First");
    await user.context.close();
  });

  test("status bar lints the Markdown and jumps to issues", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "# Title\n\n### Jumped heading\n\nSee [missing][ref].\n");
    await openDocument(user.page, id);
    const { page } = user;
    await expect(page.getByTestId("issues-button")).toContainText("2 issues");
    await page.getByTestId("issues-button").click();
    await page.getByText("Heading level jumps").click();
    await expect(page.locator(".cm-activeLine")).toContainText("### Jumped heading");
    await user.context.close();
  });

  test("rename updates the title for the document", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "# Hello\n");
    await openDocument(user.page, id);
    const { page } = user;
    await page.getByTestId("title").click();
    await page.getByTestId("title-input").fill("Renamed doc");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("title")).toHaveText("Renamed doc");
    await expect.poll(async () => (await (await page.request.get(`/api/documents/${id}`)).json()).document.title, { timeout: 15_000 }).toBe("Renamed doc");
    await user.context.close();
  });

  test("export returns clean Markdown", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "# Export me\n\nBody.\n");
    const res = await user.page.request.get(`/api/documents/${id}/export`);
    expect(res.headers()["content-type"]).toContain("text/markdown");
    expect(await res.text()).toBe("# Export me\n\nBody.\n");
    await user.context.close();
  });
});

test.describe("layout", () => {
  test("view menu switches between split, code and preview", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;
    await page.getByTestId("layout-menu").click();
    await page.getByRole("menuitemradio", { name: /Code only/ }).click();
    await expect(page.getByTestId("rich-column")).toBeHidden();
    await page.getByTestId("layout-menu").click();
    await page.getByRole("menuitemradio", { name: /Preview only/ }).click();
    await expect(page.getByTestId("code-column")).toBeHidden();
    await expect(page.getByTestId("rich-column")).toBeVisible();
    await expect.poll(() => richText(page)).toContain("Project Notes");
    await user.context.close();
  });

  test("scrolling one pane scrolls the other to the same block", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const sections = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}\n`).join("\n");
    const id = await createDocument(user.page, `# Long document\n\n${sections}`);
    await openDocument(user.page, id);
    const { page } = user;
    await expect(page.locator(".md-rich h2").first()).toHaveText("Section 0");

    // Scroll the code pane a long way down; the preview should show the same block at its top.
    await page.evaluate(() => {
      const cm = document.querySelector(".cm-scroller") as HTMLElement;
      cm.scrollTop = Math.round(cm.scrollHeight * 0.6);
    });
    await page.waitForTimeout(300);
    const topLine = await page.evaluate(() => {
      const cm = document.querySelector(".cm-scroller") as HTMLElement;
      const edge = cm.getBoundingClientRect().top + 1;
      const line = Array.from(document.querySelectorAll(".cm-line")).find((l) => {
        const r = l.getBoundingClientRect();
        return r.top <= edge && r.bottom > edge;
      });
      return line?.textContent ?? "";
    });
    expect(topLine.length).toBeGreaterThan(0);
    const expected = topLine.replace(/^#+\s*/, "").slice(0, 40);
    // The top-level preview block at the top edge of the preview scroller must be the same block.
    const topRichBlock = () =>
      page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="rich-column"] .overflow-y-auto') as HTMLElement;
        const edge = scroller.getBoundingClientRect().top;
        const block = Array.from(document.querySelectorAll(".md-rich > *")).find((el) => el.getBoundingClientRect().bottom > edge + 1);
        return block ? { text: block.textContent ?? "" } : null;
      });
    await expect.poll(async () => (await topRichBlock())?.text.slice(0, 40), { timeout: 5_000 }).toBe(expected);

    // And the other way around: scroll the preview to Section 10, the code pane follows.
    const heading = page.locator(".md-rich h2", { hasText: /^Section 10$/ });
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="rich-column"] .overflow-y-auto') as HTMLElement;
      const h = Array.from(document.querySelectorAll(".md-rich h2")).find((el) => el.textContent === "Section 10") as HTMLElement;
      scroller.scrollTop += h.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const cm = document.querySelector(".cm-scroller") as HTMLElement;
            const line = Array.from(document.querySelectorAll(".cm-line")).find((l) => l.textContent?.startsWith("## Section 10")) as HTMLElement | undefined;
            return line ? Math.abs(line.getBoundingClientRect().top - cm.getBoundingClientRect().top) : 9999;
          }),
        { timeout: 5_000 },
      )
      .toBeLessThan(40);

    // Turning sync off stops the preview from following.
    await page.getByTestId("layout-menu").click();
    await page.getByTestId("sync-scroll-toggle").click();
    const before = await heading.boundingBox();
    await page.evaluate(() => {
      const cm = document.querySelector(".cm-scroller") as HTMLElement;
      cm.scrollTop = 0;
    });
    await page.waitForTimeout(400);
    const after = await heading.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
    await user.context.close();
  });
});
