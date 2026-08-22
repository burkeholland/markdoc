import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signIn, createDocument, openDocument } from "./helpers";

const CONTENT = "# Export Heading\n\nSome text to export.\n\n- [x] done\n";

test.describe("export", () => {
  test("kebab menu offers HTML and PDF downloads", async ({ browser }) => {
    const user = await signIn(browser, "exporter");
    const id = await createDocument(user.page, CONTENT, "Export Heading");
    await openDocument(user.page, id);

    await user.page.getByTestId("more-menu").click();
    await expect(user.page.getByTestId("download-md")).toHaveText(/Download Markdown/);
    await expect(user.page.getByTestId("download-html")).toHaveText(/Download HTML/);
    await expect(user.page.getByTestId("download-pdf")).toHaveText(/Download PDF/);
    await user.page.keyboard.press("Escape");
    await user.context.close();
  });

  test("Download HTML produces a standalone page with the heading", async ({ browser }) => {
    const user = await signIn(browser, "exporter");
    const id = await createDocument(user.page, CONTENT, "Export Heading");
    // Hit the API first: this also compiles the route in dev mode so the browser download below is quick.
    const api = await user.page.request.get(`/api/documents/${id}/export?format=html`);
    expect(api.ok()).toBeTruthy();
    expect(api.headers()["content-type"]).toContain("text/html");
    await openDocument(user.page, id);

    await user.page.getByTestId("more-menu").click();
    const downloadPromise = user.page.waitForEvent("download");
    await user.page.getByTestId("download-html").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    const html = await readFile(await download.path(), "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<h1");
    expect(html).toMatch(/<h1[^>]*>Export Heading<\/h1>/);
    expect(html).toContain("<title>Export Heading</title>");
    await user.context.close();
  });

  test("Download PDF produces a PDF file", async ({ browser }) => {
    const user = await signIn(browser, "exporter");
    const id = await createDocument(user.page, CONTENT, "Export Heading");
    await openDocument(user.page, id);

    await user.page.getByTestId("more-menu").click();
    const downloadPromise = user.page.waitForEvent("download", { timeout: 60_000 });
    await user.page.getByTestId("download-pdf").click();
    await expect(user.page.getByTestId("toast").filter({ hasText: "Preparing PDF" })).toBeVisible();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    await user.context.close();
  });
});
