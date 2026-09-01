import { test, expect } from "@playwright/test";
import { signIn, createDocument, codeText, reloadHydrated, uniqueLogin } from "./helpers";

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

  test("the plain New document button still creates a blank page", async ({ browser }) => {
    const user = await signIn(browser, "templater");
    await user.page.getByTestId("new-document").click();
    await user.page.waitForURL(/\/d\/[^/]+$/);
    await expect(user.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(user.page.getByTestId("title")).toHaveText("Untitled");
    await user.context.close();
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
