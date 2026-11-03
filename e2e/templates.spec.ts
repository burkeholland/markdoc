import { test, expect } from "./fixtures";
import type { Browser, Locator, Page } from "@playwright/test";
import { signIn, devLogin, createDocument, codeText, reloadHydrated, waitForHydration, uniqueLogin } from "./helpers";

test.describe("templates", () => {
  test("a fresh user sees the template grid in the empty state", async ({ browser }) => {
    const user = await signIn(browser, uniqueLogin("fresh"));
    const empty = user.page.getByTestId("empty-state");
    await expect(empty).toBeVisible();
    await expect(empty.getByTestId("template-grid")).toBeVisible();
    await expect(empty.getByTestId("template-meeting-notes")).toBeVisible();
    await expect(empty.getByTestId("template-blank")).toBeVisible();
    await user.context.close();
  });

  test("the empty-state grid goes away once the user has a document", async ({ browser }) => {
    const user = await signIn(browser, uniqueLogin("has-docs"));
    await createDocument(user.page, "# Existing\n", "Existing");
    await reloadHydrated(user.page);
    await user.page.waitForLoadState("networkidle");
    await expect(user.page.getByTestId("document-list")).toBeVisible();
    await expect(user.page.getByTestId("empty-state")).toHaveCount(0);
    await user.context.close();
  });

  test("From template opens a dialog; Esc closes it and returns focus", async ({ browser }) => {
    const user = await signIn(browser, "templater");
    const trigger = user.page.getByTestId("new-from-template");
    await trigger.click();
    const dialog = user.page.getByTestId("template-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("template-grid").locator("li")).toHaveCount(8);
    await user.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await user.context.close();
  });

  test("picking Meeting notes creates the document and opens it in the editor", async ({ browser }) => {
    const user = await signIn(browser, "templater");
    await user.page.getByTestId("new-from-template").click();
    await user.page.getByTestId("template-dialog").getByTestId("template-meeting-notes").click();
    await user.page.waitForURL(/\/d\/[^/]+$/);
    await expect(user.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(user.page.getByTestId("title")).toHaveText("Meeting notes");
    await expect.poll(() => codeText(user.page)).toContain("## Action items");
    await expect.poll(() => codeText(user.page)).toContain(`@${user.login}`);
    await expect.poll(() => codeText(user.page)).not.toContain("{{");
    await expect(user.page.locator(".md-rich")).toContainText("Action items");
    await user.context.close();
  });

  test("the plain New document button creates an empty page with editor placeholders", async ({ browser }, testInfo) => {
    const user = await signIn(browser, "templater");
    try {
      const { page } = user;
      await page.getByTestId("new-document").click();
      await page.waitForURL(/\/d\/[^/]+$/);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect(page.getByTestId("title")).toHaveText("Untitled");
      await expect(page.locator(".cm-placeholder")).toHaveText("Start writing Markdown…");
      await expect(page.locator(".md-rich")).toHaveAttribute("data-placeholder", "Start writing. Use the toolbar, Markdown shortcuts, or edit the source on the left.");
      await expect(page.getByTestId("word-count")).toHaveText("0 words");

      const documentId = new URL(page.url()).pathname.split("/").at(-1)!;
      const storedContent = async () => {
        const response = await page.request.get(`/api/documents/${documentId}/content`);
        expect(response.ok()).toBeTruthy();
        return ((await response.json()) as { content: string }).content;
      };
      await expect.poll(storedContent).toBe("");

      await reloadHydrated(page);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect(page.getByTestId("word-count")).toHaveText("0 words");
      await expect.poll(storedContent).toBe("");
      await page.screenshot({ path: testInfo.outputPath("blank-document-placeholder.png") });
    } finally {
      await user.context.close();
    }
  });

  test("the Blank template also saves an empty document", async ({ browser }) => {
    const user = await signIn(browser, "templater");
    try {
      const { page } = user;
      await page.getByTestId("new-from-template").click();
      await page.getByTestId("template-dialog").getByTestId("template-blank").click();
      await page.waitForURL(/\/d\/[^/]+$/);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect(page.getByTestId("word-count")).toHaveText("0 words");
      const documentId = new URL(page.url()).pathname.split("/").at(-1)!;
      const response = await page.request.get(`/api/documents/${documentId}/content`);
      expect(response.ok()).toBeTruthy();
      expect(((await response.json()) as { content: string }).content).toBe("");
    } finally {
      await user.context.close();
    }
  });

  test("the API accepts a template id and lists templates", async ({ browser }) => {
    const user = await signIn(browser, "templater");
    const list = await user.page.request.get("/api/templates");
    expect(list.ok()).toBeTruthy();
    const { templates } = (await list.json()) as { templates: { id: string }[] };
    expect(templates).toHaveLength(8);

    const created = await user.page.request.post("/api/documents", { data: { template: "checklist" } });
    expect(created.status()).toBe(201);
    const { document } = (await created.json()) as { document: { id: string; title: string } };
    expect(document.title).toBe("Checklist");
    const content = await user.page.request.get(`/api/documents/${document.id}/content`);
    expect(((await content.json()) as { content: string }).content).toContain("- [ ] Item");

    const bad = await user.page.request.post("/api/documents", { data: { template: "nope" } });
    expect(bad.status()).toBe(400);
    await user.context.close();
  });
});

/**
 * Issue 2362: after a full page load or a reload of the dashboard, picking a template in the
 * "New from template" dialog did nothing (no request, no message). It only worked when the person had
 * just come from the login page, which is how every older test arrived. So each way of picking is
 * tried after each way of arriving.
 */
test.describe("picking a template in the New from template dialog", () => {
  const ARRIVALS: Record<string, (page: Page) => Promise<void>> = {
    "straight from the login page": async () => {},
    "after a full page load": async (page) => {
      await page.goto("/");
      await waitForHydration(page);
    },
    "after a reload": async (page) => {
      await reloadHydrated(page);
    },
  };
  const WAYS: Record<string, (page: Page, card: Locator) => Promise<void>> = {
    "a click": async (_page, card) => card.click(),
    "Enter": async (page, card) => {
      await card.focus();
      await page.keyboard.press("Enter");
    },
    "Space": async (page, card) => {
      await card.focus();
      await page.keyboard.press("Space");
    },
    "a tap": async (_page, card) => card.tap(),
  };

  /** A signed-in dashboard on a screen that also takes touch, reached the given way. */
  async function arrive(browser: Browser, arrival: string) {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    await devLogin(page, "templater");
    await ARRIVALS[arrival](page);
    await page.waitForLoadState("networkidle");
    return { context, page };
  }

  async function openDialog(page: Page) {
    await page.getByTestId("new-from-template").click();
    const dialog = page.getByTestId("template-dialog");
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async function expectMeetingNotes(page: Page) {
    await page.waitForURL(/\/d\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByTestId("title")).toHaveText("Meeting notes", { timeout: 30_000 });
  }

  for (const arrival of Object.keys(ARRIVALS)) {
    for (const way of Object.keys(WAYS)) {
      test(`${arrival}, ${way} on Meeting notes creates the document`, async ({ browser }) => {
        const { context, page } = await arrive(browser, arrival);
        const dialog = await openDialog(page);
        await WAYS[way](page, dialog.getByTestId("template-meeting-notes"));
        await expectMeetingNotes(page);
        await context.close();
      });
    }
  }

  test("a pick still works after the dialog was closed with Escape and opened again", async ({ browser }) => {
    const { context, page } = await arrive(browser, "after a full page load");
    await openDialog(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("template-dialog")).toHaveCount(0);
    const dialog = await openDialog(page);
    await dialog.getByTestId("template-meeting-notes").click();
    await expectMeetingNotes(page);
    await context.close();
  });

  // What a browser extension or a page translator does: it changes the page from outside the app.
  test("a pick still works after something else changed the cards (an attribute, a wrapped title)", async ({ browser }) => {
    const { context, page } = await arrive(browser, "straight from the login page");
    const dialog = await openDialog(page);
    const card = dialog.getByTestId("template-meeting-notes");
    await card.evaluate((button) => {
      button.setAttribute("data-extension", "1");
      const name = button.children[1];
      const font = document.createElement("font");
      font.append(...name.childNodes);
      name.append(font);
    });
    await card.click();
    await expectMeetingNotes(page);
    await context.close();
  });

  test("a double click makes one document", async ({ browser }) => {
    const { context, page } = await arrive(browser, "after a full page load");
    const dialog = await openDialog(page);
    let creates = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/documents") creates += 1;
    });
    await dialog.getByTestId("template-meeting-notes").dblclick();
    await expectMeetingNotes(page);
    expect(creates).toBe(1);
    await context.close();
  });
});