import { test, expect, devices, type Browser, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signIn, createDocument, openDocument, codeText, budgetMs, ensureCommentsOpen, type User } from "./helpers";
import { seedBurkeScale, h2Texts, firstH3Of, UNIQUE_WORD, UNIQUE_WORD_DOC_INDEX, MANY_DOCS, type BurkeScaleSeed } from "./fixtures/burke-scale";

/**
 * Burke-scale suite (task #321): every assertion here is a measured number against the fixture in
 * e2e/fixtures/burke-scale.ts — a ~12k-word document, a 60-document dashboard and a 25-thread
 * comments panel. Budgets are the local figures; `budgetMs` triples them on CI (see e2e/helpers.ts).
 * Each measurement is also printed as `[scale] <name> <ms> ms` so the numbers end up in the job log.
 */

const OWNER = "burke-scale";
const PEER = "burke-scale-peer";

const measured: { name: string; ms: number; budget: number }[] = [];
function record(name: string, ms: number, budget: number) {
  measured.push({ name, ms, budget });
  console.log(`[scale] ${name.padEnd(44)} ${String(Math.round(ms)).padStart(6)} ms  (budget ${budget} ms)`);
  return ms;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Navigate to the document and return the milliseconds until the header says "saved". */
async function timeOpen(page: Page, id: string): Promise<number> {
  const t0 = Date.now();
  await page.goto(`/d/${id}`);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
  const ms = Date.now() - t0;
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".md-rich")).toBeVisible();
  return ms;
}

/**
 * Type `char` in the focused code pane and measure, inside the page, the time from its keydown to the
 * moment the rich preview contains `marker` (a MutationObserver on `.md-rich`), so Playwright's
 * own round trip is not part of the number.
 */
async function keystrokeRoundTrip(page: Page, char: string, marker: string): Promise<number> {
  await page.evaluate(
    ([c, m]) => {
      const w = window as unknown as { __rt: { start: number; end: number } };
      w.__rt = { start: 0, end: 0 };
      const root = document.querySelector(".md-rich")!;
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== c) return;
        w.__rt.start = performance.now();
        document.removeEventListener("keydown", onKey, true);
      };
      document.addEventListener("keydown", onKey, true);
      const mo = new MutationObserver(() => {
        if ((root.textContent ?? "").includes(m)) {
          w.__rt.end = performance.now();
          mo.disconnect();
        }
      });
      mo.observe(root, { childList: true, characterData: true, subtree: true });
    },
    [char, marker] as const,
  );
  await page.keyboard.type(char);
  await page.waitForFunction(() => (window as unknown as { __rt: { end: number } }).__rt.end > 0, undefined, { timeout: 10_000 });
  return page.evaluate(() => {
    const { start, end } = (window as unknown as { __rt: { start: number; end: number } }).__rt;
    return end - start;
  });
}

/** MCP client over /api/mcp with a bearer token — what Copilot CLI does with the config from Settings. */
async function mcpClient(baseURL: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/api/mcp`), { requestInit: { headers: { Authorization: ["Bearer", token].join(" ") } } });
  const client = new Client({ name: "scale-spec", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test.describe("Burke-scale", () => {
  test.describe.configure({ mode: "serial" });
  let owner: User;
  let seed: BurkeScaleSeed;
  let longDocId: string;
  let h2s: string[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    // The peer signs in first so shares and @mentions resolve to a real user.
    const peer = await signIn(browser, PEER);
    await peer.context.close();
    owner = await signIn(browser, OWNER);
    seed = await seedBurkeScale(owner.page.request, { owner: OWNER, peer: PEER }, { log: (line) => console.log(line) });
    longDocId = seed.longDoc.id;
    h2s = h2Texts(seed.longDoc.content);
    // The task's bar is "< 60 s on CI"; the same flat budget applies locally (no budgetMs).
    record("seedBurkeScale (60 docs, 25 threads)", seed.elapsedMs, 60_000);
    expect(seed.elapsedMs).toBeLessThan(60_000);
    expect(seed.docs).toHaveLength(60);
    expect(h2s).toHaveLength(40);
  });

  test.afterAll(async () => {
    console.log("[scale] measurements:");
    for (const m of measured) console.log(`[scale]   ${m.name.padEnd(44)} ${String(Math.round(m.ms)).padStart(6)} ms / ${m.budget} ms`);
    await owner?.context.close();
  });

  test("1. long doc opens < 6 s, outline lists 40 H2s, keystroke → preview < 300 ms median", async () => {
    const { page } = owner;
    const openMs = record("long doc: navigation → saved", await timeOpen(page, longDocId), budgetMs(6_000));
    expect(openMs).toBeLessThan(budgetMs(6_000));
    expect((await codeText(page)).length).toBe(seed.longDoc.content.length);

    if ((await page.getByTestId("outline").count()) === 0) await page.getByTestId("outline-button").click();
    const items = page.getByTestId("outline").locator("[data-outline-item]");
    await expect(items).toHaveCount(1 + 40 + seed.longDoc.content.split("\n").filter((l) => l.startsWith("### ")).length);
    const texts = await items.allInnerTexts();
    expect(texts.filter((t) => /^\d{1,2}\. /.test(t.trim()))).toEqual(h2s);

    // Jump to the last section through the outline, then type at the very end of the code pane.
    await items.filter({ hasText: h2s[39] }).click();
    await expect(page.locator(".md-rich h2").last()).toBeInViewport();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const prefix = "zqx";
    await page.keyboard.type(prefix);
    await expect.poll(() => page.locator(".md-rich").textContent()).toContain(prefix);
    const samples: number[] = [];
    let typed = prefix;
    for (let i = 0; i < 10; i++) {
      const ch = String(i);
      typed += ch;
      samples.push(await keystrokeRoundTrip(page, ch, typed));
    }
    const med = record(`keystroke → preview (median of 10; samples ${samples.map((s) => Math.round(s)).join("/")})`, median(samples), budgetMs(300));
    expect(med).toBeLessThan(budgetMs(300));
    // Leave the document as seeded for the tests that follow.
    for (let i = 0; i < typed.length + 2; i++) await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toBe(seed.longDoc.content);
  });

  test("2. reload after create without edit: content length identical on 3 reloads", async () => {
    const { page } = owner;
    const id = await createDocument(page, seed.longDoc.content, "Reload-after-create (Burke-scale)");
    const lengths: number[] = [];
    await openDocument(page, id);
    lengths.push((await codeText(page)).length);
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await openDocument(page, id);
      lengths.push((await codeText(page)).length);
    }
    console.log(`[scale] reload lengths: ${lengths.join(", ")} (seed ${seed.longDoc.content.length})`);
    expect(lengths).toEqual(Array(4).fill(seed.longDoc.content.length));
    expect(await codeText(page)).toBe(seed.longDoc.content);
  });

  test("3. second browser (editor) joins: both cursors visible, 200-char paste arrives < 1 s, no doubling", async ({ browser }) => {
    const { page: a } = owner;
    const bob = await signIn(browser, PEER);
    try {
      await openDocument(a, longDocId);
      await openDocument(bob.page, longDocId);
      await expect(a.getByTestId("presence").locator(".avatar")).toHaveCount(2);
      await expect(bob.page.getByTestId("presence").locator(".avatar")).toHaveCount(2);

      // Each puts a caret in the code pane; the other sees it.
      await a.locator(".cm-content").click();
      await a.keyboard.press("Control+Home");
      await bob.page.locator(".cm-content").click();
      await bob.page.keyboard.press("Control+End");
      await expect(a.locator(".cm-ySelectionCaret").first()).toBeVisible();
      await expect(bob.page.locator(".cm-ySelectionCaret").first()).toBeVisible();

      // A 200-character paste at the end from Bob; timed on Alice's side with a ytext observer.
      const paste = `PASTE-${"abcdefghij".repeat(19)}-END`;
      expect(paste).toHaveLength(200);
      await a.evaluate((needle) => {
        const w = window as unknown as { __markdocSession: { ytext: { observe(fn: () => void): void; unobserve(fn: () => void): void; toString(): string } }; __pasteSeen: number };
        w.__pasteSeen = 0;
        const fn = () => {
          if (w.__markdocSession.ytext.toString().includes(needle)) {
            w.__pasteSeen = Date.now();
            w.__markdocSession.ytext.unobserve(fn);
          }
        };
        w.__markdocSession.ytext.observe(fn);
      }, paste);
      await bob.page.keyboard.press("Enter");
      await bob.page.keyboard.press("Enter");
      const t0 = Date.now();
      await bob.page.keyboard.insertText(paste);
      await a.waitForFunction(() => (window as unknown as { __pasteSeen: number }).__pasteSeen > 0, undefined, { timeout: 10_000 });
      const seen = await a.evaluate(() => (window as unknown as { __pasteSeen: number }).__pasteSeen);
      const ms = record("200-char paste: bob → alice", seen - t0, budgetMs(1_000));
      expect(ms).toBeLessThan(budgetMs(1_000));

      await expect.poll(() => codeText(a)).toContain(paste);
      const count = (s: string) => s.split(paste).length - 1;
      expect(count(await codeText(a))).toBe(1);
      expect(count(await codeText(bob.page))).toBe(1);
      await expect.poll(async () => (await codeText(a)) === (await codeText(bob.page))).toBe(true);
      // Undo the paste so the document stays as seeded.
      for (let i = 0; i < paste.length + 2; i++) await bob.page.keyboard.press("Backspace");
      await expect.poll(() => codeText(a)).toBe(seed.longDoc.content);
    } finally {
      await bob.context.close();
    }
  });

  test("4. dashboard with 60 docs: first paint < 2 s, body search < 1.5 s, 10 starred, 8 in trash", async () => {
    const { page } = owner;
    const listed = seed.docs.length - seed.trashedIds.length;
    const t0 = Date.now();
    await page.goto("/");
    await expect(page.getByTestId("document-list").getByTestId("document-card").first()).toBeVisible();
    const paint = record("dashboard: navigation → first card", Date.now() - t0, budgetMs(2_000));
    expect(paint).toBeLessThan(budgetMs(2_000));
    await expect(page.getByTestId("document-list").getByTestId("document-card")).toHaveCount(listed);

    const t1 = Date.now();
    await page.getByTestId("search").fill(UNIQUE_WORD);
    await expect(page.getByTestId("search-result")).toHaveCount(1);
    const search = record(`search "${UNIQUE_WORD}" (doc ${UNIQUE_WORD_DOC_INDEX} body only)`, Date.now() - t1, budgetMs(1_500));
    expect(search).toBeLessThan(budgetMs(1_500));
    await expect(page.getByTestId("search-result").getByRole("heading")).toHaveText(MANY_DOCS[UNIQUE_WORD_DOC_INDEX - 1].title);
    await page.getByTestId("search").fill("");
    await expect(page.getByTestId("document-list").getByTestId("document-card")).toHaveCount(listed);

    await page.getByTestId("filter-starred").click();
    await expect(page.getByTestId("document-list").getByTestId("document-card")).toHaveCount(10);
    await page.getByTestId("filter-trash").click();
    await expect(page.getByTestId("trash-card")).toHaveCount(8);
    await page.getByTestId("filter-all").click();
    await expect(page.getByTestId("document-list").getByTestId("document-card")).toHaveCount(listed);
  });

  test("5. comments panel with 25 threads opens < 1 s; resolving removes exactly one; reactions survive a reload", async () => {
    const { page } = owner;
    const { totals } = seed.commentLoad;
    const openThreads = totals.threads - totals.resolved;
    await openDocument(page, longDocId);
    await expect(page.getByTestId("comments-badge")).toHaveText(String(openThreads));
    if ((await page.getByTestId("comments-panel").count()) > 0) await page.getByTestId("comments-toggle").click();
    await expect(page.getByTestId("comments-panel")).toHaveCount(0);

    const t0 = Date.now();
    await page.getByTestId("comments-toggle").click();
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    await expect(page.getByTestId("comment-thread")).toHaveCount(openThreads);
    const ms = record(`comments panel: click → ${openThreads} open threads`, Date.now() - t0, budgetMs(1_000));
    expect(ms).toBeLessThan(budgetMs(1_000));
    const chips = page.getByTestId("comments-panel").getByTestId("reaction-chip");
    await expect(chips).toHaveCount(totals.reactions);

    // Resolve the first thread that has no reaction so the reaction count is unaffected.
    const threads = page.getByTestId("comment-thread");
    const before = await threads.count();
    let target = -1;
    for (let i = 0; i < before; i++) {
      if ((await threads.nth(i).getByTestId("reaction-chip").count()) === 0) {
        target = i;
        break;
      }
    }
    expect(target).toBeGreaterThanOrEqual(0);
    await threads.nth(target).getByTestId("comment-resolve").click();
    await expect(threads).toHaveCount(before - 1);
    await expect(page.getByTestId("comments-badge")).toHaveText(String(openThreads - 1));
    await page.getByTestId("comments-tab-resolved").click();
    await expect(page.getByTestId("comment-thread")).toHaveCount(totals.resolved + 1);
    await page.getByTestId("comments-tab-open").click();

    await page.reload();
    await openDocument(page, longDocId);
    await ensureCommentsOpen(page);
    await expect(page.getByTestId("comment-thread")).toHaveCount(before - 1);
    await expect(page.getByTestId("comments-panel").getByTestId("reaction-chip")).toHaveCount(totals.reactions);
    const api = (await (await page.request.get(`/api/documents/${longDocId}/comments`)).json()) as { comments: { resolved: boolean; reactions: Record<string, unknown>; replies: unknown[] }[] };
    expect(api.comments).toHaveLength(totals.threads);
    expect(api.comments.filter((c) => c.resolved)).toHaveLength(totals.resolved + 1);
    expect(api.comments.reduce((n, c) => n + c.replies.length, 0)).toBe(totals.replies);
  });

  test("6. phone viewport: long doc opens, outline tap scrolls to the last heading, no horizontal overflow", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto("/login");
      await page.getByTestId("dev-login").fill(OWNER);
      await page.getByTestId("dev-login-submit").click();
      await page.waitForURL((url) => url.pathname === "/");
      const t0 = Date.now();
      await page.goto(`/d/${longDocId}`);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
      record("phone: long doc navigation → saved", Date.now() - t0, budgetMs(6_000));
      await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone");
      await expect(page.locator(".md-rich")).toBeVisible();
      const overflow = () => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      expect((await overflow()).scrollWidth).toBeLessThanOrEqual((await overflow()).innerWidth);

      await page.getByTestId("outline-button").click();
      const drawer = page.getByTestId("outline-drawer");
      await expect(drawer).toBeVisible();
      const last = drawer.getByRole("button", { name: h2s[39] });
      await last.scrollIntoViewIfNeeded();
      await last.click();
      await expect(drawer).toHaveCount(0);
      const lastH2 = page.locator(".md-rich h2").last();
      await expect(lastH2).toHaveText(h2s[39]);
      await expect(lastH2).toBeInViewport();
      expect((await overflow()).scrollWidth).toBeLessThanOrEqual((await overflow()).innerWidth);
      await page.screenshot({ path: test.info().outputPath("phone-long-doc.png") });
    } finally {
      await context.close();
    }
  });

  test("7. export: HTML has all 40 H2s; PDF is application/pdf > 50 KB", async () => {
    const { page } = owner;
    const html = await page.request.get(`/api/documents/${longDocId}/export?format=html`, { timeout: 60_000 });
    expect(html.status()).toBe(200);
    expect(html.headers()["content-type"]).toContain("text/html");
    const body = await html.text();
    expect(body.match(/<h2[\s>]/g) ?? []).toHaveLength(40);
    for (const h of h2s) expect(body).toContain(h);

    const t0 = Date.now();
    const pdf = await page.request.get(`/api/documents/${longDocId}/export?format=pdf`, { timeout: 120_000 });
    if (pdf.status() === 503) {
      test.skip(true, `PDF export returned 503 (no Chromium on this host): ${(await pdf.text()).slice(0, 120)}`);
    }
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    const bytes = await pdf.body();
    record(`PDF export (${Math.round(bytes.length / 1024)} KB)`, Date.now() - t0, budgetMs(60_000));
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(50 * 1024);
  });

  test("8. agent path over /api/mcp: read_document returns the full text; a suggest on section 37 shows in the UI < 2 s", async ({ baseURL }) => {
    const { page } = owner;
    expect(seed.token).toBeTruthy();
    await openDocument(page, longDocId);
    const editorText = await codeText(page);
    const client = await mcpClient(baseURL!, seed.token!);
    try {
      const read = await client.callTool({ name: "markdoc_read_document", arguments: { id: longDocId } });
      expect(read.isError).toBeFalsy();
      const content = (read.structuredContent as { content: string }).content;
      expect(content.length).toBe(editorText.length);
      expect(content).toBe(editorText);

      const find = firstH3Of(seed.longDoc.content, 37).slice(4);
      const replace = `${find} (revised by the agent)`;
      const t0 = Date.now();
      const suggested = await client.callTool({ name: "markdoc_suggest", arguments: { id: longDocId, edits: [{ find, replace }] } });
      expect(suggested.isError).toBeFalsy();
      expect((suggested.structuredContent as { suggestions: number }).suggestions).toBeGreaterThan(0);
      await expect(page.locator(".md-rich .md-suggest-insert").filter({ hasText: "revised by the agent" }).first()).toBeVisible({ timeout: 15_000 });
      const ms = record("markdoc_suggest → visible in rich pane", Date.now() - t0, budgetMs(2_000));
      expect(ms).toBeLessThan(budgetMs(2_000));
      await ensureCommentsOpen(page);
      await page.getByTestId("comments-tab-suggestions").click();
      await expect(page.getByTestId("suggestion-card").filter({ hasText: "revised by the agent" })).toHaveCount(1);
    } finally {
      await client.close();
    }
  });
});

/** The 60-document dashboard, for the report screenshot; kept separate so a failing budget above never hides it. */
test("dashboard screenshot (Burke-scale)", async ({ browser }: { browser: Browser }) => {
  const user = await signIn(browser, OWNER);
  try {
    await user.page.goto("/");
    await expect(user.page.getByTestId("document-list").getByTestId("document-card").first()).toBeVisible();
    await user.page.screenshot({ path: test.info().outputPath("dashboard-60-docs.png"), fullPage: false });
  } finally {
    await user.context.close();
  }
});
