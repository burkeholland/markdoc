import { test, expect } from "@playwright/test";
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

    await page.keyboard.type("\n\n| a | b |\n|---|---|\n| 1 | 2 |");
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
});
