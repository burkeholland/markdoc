import { expect, test, type Page } from "@playwright/test";
import { codeText, createDocument, focusCodeEnd, openDocument, shareWith, signIn, uniqueLogin } from "./helpers";

/**
 * A whole-document replace (`PUT /content`, what `markdoc_replace_content` calls) while people have the
 * document open (#2341). Before, the replace ran a text diff with no limit on the server's one thread:
 * 8,000 characters replaced by 8,000 others kept every request waiting for 2 s, 40,000 for about a minute.
 */

const ASCII = "abcdefghijklmnopqrstuvwxyz";
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
/** One paragraph on one line, about `chars` long. */
function paragraph(chars: number, seed: number): string {
  const r = rng(seed);
  const words: string[] = [];
  let n = 0;
  while (n < chars) {
    let w = "";
    for (let i = 2 + Math.floor(r() * 8); i > 0; i--) w += ASCII[Math.floor(r() * 26)];
    words.push(w);
    n += w.length + 1;
  }
  return words.join(" ");
}
const documentOf = (paragraphs: string[]) => `# Report\n\n${paragraphs.join("\n\n")}\n`;
const serverText = async (page: Page, id: string) => ((await (await page.request.get(`/api/documents/${id}/content`)).json()) as { content: string }).content;

test.describe("a whole-document replace with people in the document", () => {
  test("a person types while an agent's replace arrives: both editors end with the server's text, letters typed after it are kept, and a hash protects the rest", async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await signIn(browser, uniqueLogin("replace-owner"));
    const typist = await signIn(browser, uniqueLogin("replace-typist"));
    try {
      const paragraphs = Array.from({ length: 8 }, (_, i) => paragraph(740, 100 + i));
      const id = await createDocument(owner.page, documentOf(paragraphs), "Replace while typing");
      await shareWith(owner.page, id, typist.login, "editor");
      await openDocument(owner.page, id);
      await openDocument(typist.page, id);

      // The typist writes at the end of the document, one key at a time, while the replace is on its way.
      await focusCodeEnd(typist.page);
      const typed = "TYPED WHILE THE REPLACE ARRIVED";
      const typing = typist.page.keyboard.type(typed, { delay: 40 });
      // The agent read the text and sends it back with paragraphs 3 and 6 rewritten.
      const rewritten = [...paragraphs];
      rewritten[2] = paragraph(740, 903);
      rewritten[5] = paragraph(740, 906);
      const sent = documentOf(rewritten);
      const answer = await owner.page.request.put(`/api/documents/${id}/content`, { data: { content: sent } });
      expect(answer.status()).toBe(200);
      await typing;

      // Everybody ends with the same text.
      const settled = async () => {
        await expect.poll(async () => (await codeText(owner.page)) === (await codeText(typist.page)), { timeout: 30_000 }).toBe(true);
        const text = await codeText(typist.page);
        await expect.poll(() => serverText(owner.page, id), { timeout: 30_000 }).toBe(text);
        return text;
      };
      let text = await settled();
      // The rewrite landed and the six other paragraphs are untouched.
      expect(text).toContain(rewritten[2]);
      expect(text).toContain(rewritten[5]);
      for (const k of [0, 1, 3, 4, 6, 7]) expect(text).toContain(paragraphs[k]);
      expect(text).not.toContain(paragraphs[2]);
      expect(text).not.toContain(paragraphs[5]);
      // A replace without a hash makes the text what the agent sent: letters that had reached the server before
      // it and are not in the agent's text are replaced with the rest (as they always were). Every letter typed
      // from then on is kept, in order: what is left is the end of what was typed, and nothing else.
      const left = text.replace(sent.trimEnd(), "").replace(/^\s+|\s+$/g, "");
      expect(typed.endsWith(left), `left of the typed words: ${JSON.stringify(left)}`).toBe(true);

      // With the hash of what the agent read, nothing a person typed since is replaced: the write is refused.
      const read = (await (await owner.page.request.get(`/api/documents/${id}/content`)).json()) as { contentHash: string };
      await typist.page.keyboard.type(" KEPT BY THE HASH", { delay: 20 });
      await expect.poll(() => serverText(owner.page, id), { timeout: 30_000 }).toContain("KEPT BY THE HASH");
      const refused = await owner.page.request.put(`/api/documents/${id}/content`, { data: { content: documentOf(paragraphs), ifContentHash: read.contentHash } });
      expect(refused.status()).toBe(409);
      text = await settled();
      expect(text).toContain("KEPT BY THE HASH");
      expect(text).toContain(rewritten[2]);

      // And typing goes on as before after a replace.
      await typist.page.keyboard.type(" AND AFTER", { delay: 20 });
      await expect.poll(() => codeText(owner.page), { timeout: 30_000 }).toContain("KEPT BY THE HASH AND AFTER");
      text = await settled();
      expect(text.endsWith("KEPT BY THE HASH AND AFTER") || text.trimEnd().endsWith("KEPT BY THE HASH AND AFTER")).toBe(true);
    } finally {
      await owner.context.close();
      await typist.context.close();
    }
  });

  test("40,000 characters replaced by 40,000 others: answered in seconds, the server answers others meanwhile, and the open editor has the new text", async ({ browser }) => {
    test.setTimeout(240_000);
    const owner = await signIn(browser, uniqueLogin("replace-large"));
    try {
      const before = documentOf(Array.from({ length: 50 }, (_, i) => paragraph(790, 200 + i)));
      const after = documentOf(Array.from({ length: 50 }, (_, i) => paragraph(790, 700 + i)));
      const id = await createDocument(owner.page, before, "Large replace");
      await openDocument(owner.page, id);

      // Ask the health route every 250 ms while the replace runs; the longest wait for an answer is what others feel.
      let asking = true;
      let longest = 0;
      const health = (async () => {
        while (asking) {
          const started = Date.now();
          const res = await owner.page.request.get("/api/health", { timeout: 120_000 });
          expect(res.ok()).toBe(true);
          longest = Math.max(longest, Date.now() - started);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })();
      const started = Date.now();
      const answer = await owner.page.request.put(`/api/documents/${id}/content`, { data: { content: after }, timeout: 120_000 });
      const took = Date.now() - started;
      asking = false;
      await health;
      expect(answer.status()).toBe(200);
      // About a minute without the bound. With it the answer is there in well under a second on a quiet machine;
      // the limits here leave room for a dev server on a machine at full load.
      expect(took).toBeLessThan(15_000);
      expect(longest).toBeLessThan(10_000);
      await expect.poll(() => codeText(owner.page), { timeout: 60_000 }).toBe(after);
      expect(await serverText(owner.page, id)).toBe(after);
    } finally {
      await owner.context.close();
    }
  });
});
