import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, reloadHydrated } from "./helpers";

// 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");
const mod = process.platform === "darwin" ? "Meta" : "Control";

interface DropFile {
  name: string;
  type: string;
  text?: string;
  base64?: string;
}

/**
 * Drop files on `selector` by dispatching synthetic dragenter/dragover/drop events with a
 * DataTransfer that carries File objects; the same window/ProseMirror/CodeMirror handlers
 * run as for a real drag from the desktop.
 */
async function dropFiles(page: Page, selector: string, files: DropFile[], at?: { x: number; y: number }) {
  await page.evaluate(
    ({ selector, files, at }) => {
      const target = document.querySelector(selector) as HTMLElement | null;
      if (!target) throw new Error(`${selector} not found`);
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = f.base64 ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(f.text ?? "");
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const rect = target.getBoundingClientRect();
      const clientX = at?.x ?? rect.left + Math.min(40, rect.width / 2);
      const clientY = at?.y ?? rect.top + Math.min(20, rect.height / 2);
      for (const type of ["dragenter", "dragover", "drop"] as const) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX, clientY }));
      }
    },
    { selector, files, at },
  );
}

test.describe("import local files", () => {
  test("picking a .md file opens it as a new document titled from its H1", async ({ browser }) => {
    const { page } = await signIn(browser, "importer");
    await expect(page.getByTestId("open-file")).toBeVisible();
    await page.getByTestId("import-file-input").setInputFiles({
      name: "roadmap.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("---\ntitle: Q3 Roadmap\n---\n\n# Roadmap draft\r\n\r\nShip the importer.\r\n"),
    });
    await page.waitForURL(/\/d\/[a-z0-9]+$/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(".md-rich")).toContainText("Ship the importer.");
    await expect(page.getByTestId("title")).toHaveText("Q3 Roadmap");
    const text = await codeText(page);
    expect(text).toContain("title: Q3 Roadmap");
    expect(text).toContain("# Roadmap draft\n\nShip the importer.\n");
    expect(text).not.toContain("\r");
  });

  test("dropping a .md file on the dashboard imports it", async ({ browser }) => {
    const { page } = await signIn(browser, "dropper");
    const dropzone = page.getByTestId("import-dropzone");
    await expect(dropzone).toHaveAttribute("data-active", "false");
    // dragenter shows the overlay; drop imports and navigates.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "x.md", { type: "text/markdown" }));
      document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(dropzone).toHaveAttribute("data-active", "true");
    await expect(dropzone).toContainText("Drop Markdown files to import");
    await dropFiles(page, "body", [{ name: "dropped.md", type: "text/markdown", text: "# Dropped Note\n\nFrom the desktop.\n" }]);
    await page.waitForURL(/\/d\/[a-z0-9]+$/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(".md-rich")).toContainText("From the desktop.");
    await expect(page.getByTestId("title")).toHaveText("Dropped Note");
  });

  test("dropping two files lists both with Open links and refreshes the dashboard", async ({ browser }) => {
    const { page } = await signIn(browser, "batcher");
    await dropFiles(page, "body", [
      { name: "alpha.md", type: "text/markdown", text: "# Alpha\n\none\n" },
      { name: "beta.txt", type: "text/plain", text: "Just plain text.\n" },
    ]);
    const dialog = page.getByTestId("import-dialog");
    await expect(dialog).toBeVisible();
    const items = page.getByTestId("import-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute("data-status", "done");
    await expect(items.nth(1)).toHaveAttribute("data-status", "done");
    await expect(items.nth(0)).toContainText("Alpha");
    await expect(items.nth(1)).toContainText("beta");
    const links = page.getByTestId("import-open");
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute("href", /\/d\/[a-z0-9]+$/);
    // Still on the dashboard; the list behind the dialog now has both documents.
    expect(new URL(page.url()).pathname).toBe("/");
    await links.nth(1).click();
    await page.waitForURL(/\/d\/[a-z0-9]+$/);
    await expect(page.locator(".md-rich")).toContainText("Just plain text.");
    await page.goto("/");
    await expect(page.getByText("Alpha", { exact: true }).first()).toBeVisible();
  });

  test("an image dropped with the Markdown that references it becomes an asset", async ({ browser }) => {
    const { page } = await signIn(browser, "photographer");
    await dropFiles(page, "body", [
      { name: "trip.md", type: "text/markdown", text: "# Trip\n\n![Beach](./images/beach.png)\n\n![Missing](lost.png)\n" },
      { name: "beach.png", type: "image/png", base64: PNG_BASE64 },
    ]);
    // `lost.png` is a warning, so the dialog stays with it (#2292) and Open goes to the document.
    await expect(page.getByTestId("import-warning")).toContainText("lost.png");
    await page.getByTestId("import-open").click();
    await page.waitForURL(/\/d\/[a-z0-9]+$/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    const text = await codeText(page);
    const m = /!\[Beach\]\((\/api\/assets\/[a-z0-9]+)\)/.exec(text);
    expect(m).not.toBeNull();
    expect(text).toContain("![Missing](lost.png)");
    await expect(page.locator(`.md-rich img[src="${m![1]}"]`)).toHaveCount(1);
    // The rewrite must live in ystate, not just the content column: a reload (re-hydration) still shows the asset.
    await reloadHydrated(page);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(`.md-rich img[src="${m![1]}"]`)).toHaveCount(1);
    expect(await codeText(page)).not.toContain("beach.png");
    const res = await page.request.get(m![1]);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect((await res.body()).equals(PNG)).toBeTruthy();
  });

  test("a batch over 10 MiB imports file by file with every file done (#2340)", async ({ browser }) => {
    const { page } = await signIn(browser, "bulkimporter");
    const filler = "lorem ipsum ".repeat(170_000); // ~2 MB of text per file
    const files = Array.from({ length: 6 }, (_, i) => ({ name: `bulk-${i}.md`, type: "text/markdown", text: `# Bulk ${i}\n\n${filler}` }));
    const requests: number[] = [];
    page.on("request", (req) => {
      if (req.url().endsWith("/api/import/file")) requests.push(req.postDataBuffer()?.length ?? 0);
    });
    await dropFiles(page, "body", files);
    const items = page.getByTestId("import-item");
    await expect(items).toHaveCount(6);
    for (let i = 0; i < 6; i++) await expect(items.nth(i)).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    expect(requests).toHaveLength(6);
    for (const size of requests) expect(size).toBeLessThan(10 * 1024 * 1024);
  });

  test("one file with a refused image keeps the dialog with the warning and an Open link (#2292)", async ({ browser }) => {
    const { page } = await signIn(browser, "warnedimporter");
    await dropFiles(page, "body", [
      { name: "trip.md", type: "text/markdown", text: "# Trip\n\n![Beach](beach.png)\n" },
      // Declared PNG, but the bytes are not an image: the server refuses it.
      { name: "beach.png", type: "image/png", text: "not a picture" },
    ]);
    const dialog = page.getByTestId("import-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("import-warning").first()).toContainText("“beach.png”:");
    expect(new URL(page.url()).pathname).toBe("/");
    await dialog.screenshot({ path: test.info().outputPath("single-file-warning.png") });
    await page.getByTestId("import-open").click();
    await page.waitForURL(/\/d\/[a-z0-9]+$/);
  });

  test("a binary file renamed .md is refused with a plain message and creates nothing (#2419)", async ({ browser }) => {
    const { page } = await signIn(browser, "binaryimporter");
    const imports: string[] = [];
    page.on("request", (req) => {
      if (req.url().endsWith("/api/import/file")) imports.push(req.url());
    });
    await page.getByTestId("import-file-input").setInputFiles({
      name: "fake.md",
      mimeType: "text/markdown",
      buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("notreally")]),
    });
    const dialog = page.getByTestId("import-dialog");
    await expect(dialog).toContainText("“fake.md” doesn't look like a text or Markdown file");
    await dialog.screenshot({ path: test.info().outputPath("binary-refused.png") });
    expect(imports).toEqual([]);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("dropping a .md file on the editor offers Insert at cursor", async ({ browser }) => {
    const user = await signIn(browser, "inserter");
    const id = await createDocument(user.page, "# Notes\n\nFirst line.\n");
    await openDocument(user.page, id);
    const { page } = user;

    // Rich pane: the dialog appears; "Insert at cursor" puts the text where it was dropped.
    await dropFiles(page, ".ProseMirror", [{ name: "snippet.md", type: "text/markdown", text: "Inserted **bold** text.\n" }]);
    await expect(page.getByTestId("file-drop-dialog")).toBeVisible();
    await expect(page.getByTestId("file-drop-replace")).toBeVisible();
    await expect(page.getByTestId("file-drop-new")).toBeVisible();
    await page.getByTestId("file-drop-insert").click();
    await expect(page.getByTestId("file-drop-dialog")).toBeHidden();
    await expect.poll(() => codeText(page)).toContain("Inserted **bold** text.");
    await expect.poll(() => codeText(page)).toContain("First line.");
    await expect(page.locator(".md-rich strong", { hasText: "bold" })).toBeVisible();

    // Source pane: same dialog; "Replace document content" swaps the whole text.
    await dropFiles(page, ".cm-content", [{ name: "whole.txt", type: "text/plain", text: "# Replaced\n\nEverything new.\n" }]);
    await expect(page.getByTestId("file-drop-dialog")).toBeVisible();
    await page.getByTestId("file-drop-replace").click();
    await expect.poll(() => codeText(page)).toBe("# Replaced\n\nEverything new.\n");
  });

  test("the dashboard command palette has Open file…", async ({ browser }) => {
    const { page } = await signIn(browser, "paletteer");
    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill("open file");
    await expect(page.getByTestId("palette-item-dash:open-file")).toBeVisible();
    await expect(page.getByTestId("palette-item-dash:open-file")).toContainText("Open file…");
    // Running it opens the native picker, which Playwright intercepts.
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("palette-item-dash:open-file").click();
    const fc = await chooser;
    expect(fc.isMultiple()).toBeTruthy();
  });
});
