import { test, expect, type Page, type Response } from "@playwright/test";
import { budgetMs, createDocument, focusRichEnd, openDocument, signIn } from "./helpers";

// highlight.js' core and its 37 `common` grammars live in their own chunk (src/editor/prosemirror/code-highlight-languages.ts)
// that the rich pane imports only once a document shows a code block with a recognised language. A chunk
// is recognised by its body, not its name: Turbopack names chunks differently in dev and production.
const GRAMMAR_MARKER = "Visual Basic .NET"; // the `name` of the vbnet grammar; nothing else in the app carries it

const PROSE_DOC = ["# No code here", "", "A paragraph with `inline code` and a [link](https://example.com).", "", "- one", "- two", "", "Closing paragraph.", ""].join("\n");
const CODE_DOC = ["# Code here", "", "```js", "const answer = 42;", "function f() { return answer; }", "```", ""].join("\n");

/** Records every `/_next/static/chunks/*.js` response of `page`, classified as grammar chunk or not. */
function watchChunks(page: Page) {
  const pending: Promise<void>[] = [];
  const chunks: { url: string; grammar: boolean }[] = [];
  const isChunk = (response: Response) => /\/_next\/static\/chunks\/.*\.js(\?|$)/.test(response.url());
  page.on("response", (response) => {
    if (!isChunk(response)) return;
    pending.push(
      response
        .text()
        .then((body) => {
          chunks.push({ url: response.url(), grammar: body.includes(GRAMMAR_MARKER) });
        })
        .catch(() => {
          chunks.push({ url: response.url(), grammar: false });
        }),
    );
  });
  return {
    async settled() {
      await Promise.all(pending);
      return chunks;
    },
    async grammarRequests() {
      return (await this.settled()).filter((c) => c.grammar).map((c) => c.url);
    },
  };
}

/** Console errors of `page` (a failed chunk load would surface here). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.describe("lazy code-block grammars", () => {
  test("a document without code never requests the grammar chunk; one with a ```js block requests it exactly once and colours within 2 s", async ({
    browser,
  }) => {
    // Warm the dev server's on-demand compile of the lazy chunk so the timing below measures the network + redecorate, not Turbopack.
    const warm = await signIn(browser, "hl-warm");
    const warmId = await createDocument(warm.page, CODE_DOC, "warm");
    await openDocument(warm.page, warmId);
    await expect(warm.page.locator(".md-rich pre .hljs-keyword").first()).toBeVisible();
    await warm.context.close();

    // Prose only: the chunk is never fetched, not even after editing.
    const prose = await signIn(browser, "hl-prose");
    const proseErrors = collectErrors(prose.page);
    const proseChunks = watchChunks(prose.page);
    const proseId = await createDocument(prose.page, PROSE_DOC, "Prose only");
    await openDocument(prose.page, proseId);
    await focusRichEnd(prose.page);
    await prose.page.keyboard.type(" And more words.");
    await expect(prose.page.locator(".md-rich > p").last()).toHaveText("Closing paragraph. And more words.");
    await expect(prose.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await prose.page.waitForLoadState("networkidle");
    const proseAll = await proseChunks.settled();
    expect(proseAll.length, "the editor loaded some chunks").toBeGreaterThan(0);
    expect(await proseChunks.grammarRequests()).toEqual([]);
    await expect(prose.page.locator('.md-rich [class*="hljs-"]')).toHaveCount(0);
    expect(proseErrors).toEqual([]);
    await prose.context.close();

    // A fenced block with a recognised language: exactly one grammar fetch, colour within budget.
    const code = await signIn(browser, "hl-code");
    const codeErrors = collectErrors(code.page);
    const codeChunks = watchChunks(code.page);
    const codeId = await createDocument(code.page, CODE_DOC, "Code here");
    await openDocument(code.page, codeId);
    const shown = Date.now();
    const keyword = code.page.locator(".md-rich pre .hljs-keyword").first();
    await expect(keyword).toBeVisible({ timeout: budgetMs(2_000) });
    const colouredAfterMs = Date.now() - shown;
    await expect(keyword).toHaveText("const");
    await expect(code.page.locator(".md-rich pre .hljs-number")).toHaveText("42");
    await code.page.waitForLoadState("networkidle");
    const grammarRequests = await codeChunks.grammarRequests();
    expect(grammarRequests, `grammar chunk requests: ${grammarRequests.join(", ")}`).toHaveLength(1);
    expect(colouredAfterMs).toBeLessThanOrEqual(budgetMs(2_000));
    test.info().annotations.push({
      type: "lazy-grammars",
      description: `coloured ${colouredAfterMs} ms after the editor was ready; grammar chunk ${grammarRequests[0]}`,
    });
    console.log(`[code-highlight] coloured after ${colouredAfterMs} ms; grammar chunk: ${grammarRequests[0]}`);

    // Typing inside the block re-highlights it without fetching anything again. The block ends the document, so
    // focusRichEnd lands the caret there and waits for the click's selection to settle before any key is pressed.
    await focusRichEnd(code.page);
    await code.page.keyboard.press("Enter");
    await code.page.keyboard.type("let later = true;");
    await expect(code.page.locator(".md-rich pre .hljs-keyword")).toHaveCount(4);
    await expect(code.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await code.page.waitForLoadState("networkidle");
    expect(await codeChunks.grammarRequests()).toHaveLength(1);
    expect(codeErrors).toEqual([]);
    await code.context.close();
  });

  test("typing a fenced block into a plain document fetches the grammars once and colours the block", async ({ browser }) => {
    const user = await signIn(browser, "hl-typing");
    const errors = collectErrors(user.page);
    const chunks = watchChunks(user.page);
    const id = await createDocument(user.page, PROSE_DOC, "Typed later");
    await openDocument(user.page, id);
    await user.page.waitForLoadState("networkidle");
    expect(await chunks.grammarRequests()).toEqual([]);

    await focusRichEnd(user.page);
    await user.page.keyboard.press("Enter");
    await user.page.keyboard.type("```ts");
    await expect(user.page.locator(".md-rich > p").last()).toHaveText("```ts");
    await user.page.keyboard.press("Enter");
    await expect(user.page.locator(".md-rich > pre[data-language='ts']")).toHaveCount(1);
    await user.page.keyboard.type("const n: number = 1;");
    await expect(user.page.locator(".md-rich pre .hljs-keyword").first()).toHaveText("const");
    await expect(user.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await user.page.waitForLoadState("networkidle");
    expect(await chunks.grammarRequests()).toHaveLength(1);

    // An unknown language stays plain and is labelled as such; still no second fetch.
    await user.page.locator(".md-rich pre input[aria-label='Code block language']").fill("brainfuck");
    await user.page.keyboard.press("Enter");
    await expect(user.page.locator(".md-rich > pre.md-code-unknown-lang")).toHaveCount(1);
    await expect(user.page.locator('.md-rich pre [class*="hljs-"]')).toHaveCount(0);
    await user.page.waitForLoadState("networkidle");
    expect(await chunks.grammarRequests()).toHaveLength(1);
    expect(errors).toEqual([]);
    await user.context.close();
  });
});
