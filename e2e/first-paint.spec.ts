import { test, expect } from "./fixtures";
import { signIn, createDocument, waitForEditor, type User } from "./helpers";

/**
 * First-paint budget of the editor page (task #1545, spike #1505). `/d/<id>` ships the preview and a
 * placeholder of the shell's chrome; the editor stack (ProseMirror, Yjs, micromark, Radix, the shell:
 * 8 chunks, ≈ 924 kB) is requested by `next/dynamic({ ssr: false })` once the placeholder has hydrated.
 *
 * Two rows. The first runs everywhere: the HTML is the placeholder, not the shell. The second is the size
 * budget and needs the production build the numbers were taken on (`PROD_BASE_URL`, as prod-smoke.spec.ts):
 * the scripts a browser fetches before the placeholder hydrates — the HTML's `<script src>` tags minus the
 * `noModule` legacy polyfill, which module-capable browsers never request — measured 7 / 464 810 B at the
 * change (the spike: 8 / 470 351 B on its base), none of them the editor's. Dev serves one chunk per module
 * and lists the `dynamic()` target's chunk (`src_components_editor_editor-shell_tsx_….js`) among the page's
 * scripts, so neither the count nor the "no editor chunk" check means anything there.
 */

const MAX_SCRIPTS = 9;
const MAX_BYTES = 480_000;
const prod = process.env.PROD_BASE_URL?.replace(/\/$/, "");

/** `<script src>` tags of the server HTML, minus `noModule` (fetched by no browser the app supports). */
function fetchedScripts(html: string): string[] {
  const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  const srcs = tags
    .filter((tag) => !/\bnomodule\b/i.test(tag))
    .map((tag) => /\ssrc="([^"]+)"/.exec(tag)?.[1])
    .filter((src): src is string => !!src);
  return [...new Set(srcs)];
}

test.describe("editor page first paint", () => {
  let user: User;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, "first-paint");
  });

  test.afterAll(async () => {
    await user.context.close();
  });

  test("the server HTML is the placeholder, not the shell", async () => {
    const { page } = user;
    const id = await createDocument(page, "# Budget\n\nA paragraph.\n", "Budget");
    const response = await page.request.get(`/d/${id}`);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('data-testid="editor-loading"');
    expect(html).toContain('data-testid="rich-placeholder"');
    expect(html).not.toContain('data-testid="editor-shell"');
    expect(fetchedScripts(html).length).toBeGreaterThan(0);
  });

  test.describe("production build", () => {
    test.skip(!prod, "PROD_BASE_URL not set: the budget is for the production build's chunking");

    test(`a browser fetches at most ${MAX_SCRIPTS} scripts / ${MAX_BYTES.toLocaleString("en-US")} B before the placeholder hydrates, none of them the editor's`, async () => {
      const { page } = user;
      const id = await createDocument(page, "# Budget\n\nA paragraph.\n", "Budget");
      const html = await (await page.request.get(`/d/${id}`)).text();
      const srcs = fetchedScripts(html);
      // Production chunk names are hashes; a module name here means the editor stack came back into the initial graph.
      expect(srcs.filter((s) => /editor-shell|prosemirror|yjs|codemirror|micromark/i.test(s))).toEqual([]);
      const sizes = await Promise.all(
        srcs.map(async (src) => {
          const res = await page.request.get(src);
          expect(res.ok(), `${src} → ${res.status()}`).toBe(true);
          return { src, bytes: (await res.body()).length };
        }),
      );
      const total = sizes.reduce((a, b) => a + b.bytes, 0);
      console.log(`[defer] /d/<id> first-paint scripts: ${srcs.length} / ${total.toLocaleString("en-US")} B (identity)`);
      for (const { src, bytes } of sizes) console.log(`[defer]   ${bytes.toString().padStart(8)}  ${src}`);
      expect(srcs.length).toBeLessThanOrEqual(MAX_SCRIPTS);
      expect(total).toBeLessThanOrEqual(MAX_BYTES);
    });

    // The dashboard fetches the editor's code once it is idle (`warm-editor.ts`), so the click on a document
    // goes straight to the shell. Before that the click fetched 15 scripts (the shell, then the code pane in a
    // second round) and the page showed empty chrome, the shell and the code pane one after the other.
    test("opening a document from the dashboard fetches no editor code after the click", async () => {
      const { page } = user;
      const id = await createDocument(page, "# Warm\n\nA paragraph.\n", "Warm");
      await page.goto("/");
      await page.locator("html[data-editor-warm]").waitFor({ state: "attached", timeout: 30_000 });
      const scripts: { url: string; bytes: number }[] = [];
      page.on("response", async (response) => {
        if (response.request().resourceType() !== "script") return;
        scripts.push({ url: response.url(), bytes: (await response.body().catch(() => Buffer.alloc(0))).length });
      });
      await page.locator(`a[data-testid="document-card"][href="/d/${id}"]`).click();
      await waitForEditor(page);
      await expect(page.locator(".cm-content")).toContainText("A paragraph.");
      // The placeholder is skipped: the shell's module was in memory when the page rendered.
      await expect(page.getByTestId("editor-loading")).toHaveCount(0);
      console.log(`[warm] scripts after the click: ${scripts.length} / ${scripts.reduce((a, s) => a + s.bytes, 0).toLocaleString("en-US")} B`);
      // What may still load is the document page's own entry (two chunks, ≈ 30 kB); the editor stack is ≈ 1.5 MB.
      expect(scripts.length).toBeLessThanOrEqual(3);
      expect(scripts.reduce((a, s) => a + s.bytes, 0)).toBeLessThanOrEqual(100_000);
    });
  });
});
