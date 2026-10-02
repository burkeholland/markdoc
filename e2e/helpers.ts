import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export interface User {
  context: BrowserContext;
  page: Page;
  login: string;
}

/**
 * Wall-clock budget for a timing assertion ("the view follows within a second"). The 2-vCPU CI runner
 * shares its cores between two workers and the dev server, so it gets three times the local
 * allowance (the same rule as the perf budgets from task #278); the local figure stays tight so a
 * real slowdown is still caught here.
 *
 * `E2E_BUDGET_SCALE` (a number ≥ 1) replaces that multiplier for one run: it exists for a targeted pass
 * on a loaded shared machine, where the performance budgets go red for reasons unrelated to the change
 * under test. A report from a scaled run must say so (the run log's first line states the scale).
 * Release preflight and CI never set it — CI keeps its ×3 by default and preflight runs at ×1.
 */
export { budgetMs, budgetScale } from "../scripts/lib/test-budget";

// `boundingBox()` is CSS px computed from device px: at DPR 2/3 a 40 px control reads 39.99998 (#1350).
// Assertions on minimum sizes (touch targets) compare whole CSS pixels; the fraction is rounding noise.
export const cssPx = (n: number): number => Math.round(n);

/**
 * A login of its own per run (`searcher-m1abc2de`). A test that asserts an exact count over the account's
 * data (dashboard cards, starred strip, search results, notifications strip, webhooks) must not sign in as a
 * fixed literal: on the shared server a second run (`--repeat-each`, a CI retry) sees the first run's rows
 * too. Call it once per person and reuse the returned login wherever the test names that person.
 */
export const uniqueLogin = (base: string): string => `${base}-${Date.now().toString(36)}`;

/** Sign in with the development login and land on the dashboard. */
export async function signIn(browser: Browser, login: string): Promise<User> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await devLogin(page, login);
  await page.waitForLoadState("networkidle");
  return { context, page, login };
}

/**
 * The development login on an existing page: /login → React hydrated → fill → submit → URL is `/`.
 * The first `goto` of a test lands on server markup, and a `fill`/`click` that arrives before
 * `html[data-hydrated]` is dropped under load (task #1263), so every dev-login site goes through here.
 * Returns as soon as the dashboard URL is in; callers that want its requests settled add
 * `page.waitForLoadState("networkidle")` (as `signIn` does).
 */
export async function devLogin(page: Page, login: string) {
  await page.goto("/login");
  await waitForHydration(page);
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
}

/**
 * Resolves once React has hydrated the current document (html[data-hydrated], set by <HydrationMarker>
 * from the root layout). Server markup carries no handlers, so a click that lands before this is dropped;
 * `data-theme` is written by the boot script before React runs and is not a readiness signal.
 *
 * On `/d/<id>` this is not enough: the server renders only a placeholder there (chrome + the preview,
 * `src/app/d/[id]/editor-client.tsx`), so hydrated means "placeholder committed", not "editor interactive";
 * use `openDocument` / `waitForEditor` before touching a header, toolbar or status-bar control.
 */
export async function waitForHydration(page: Page, timeout = 30_000) {
  await page.locator("html[data-hydrated]").waitFor({ state: "attached", timeout });
}

/**
 * Resolves once the editor shell (`[data-testid=editor-shell]`) is in the DOM of a `/d/<id>` page. The shell
 * mounts when its chunks have loaded — ≈ 0.4 s after hydration on a desktop, 10–15 s on a phone at 4× CPU
 * (#1505) — and every header/toolbar/status-bar control exists only from then on. Locators that live in the
 * shell (`save-state`, `.cm-content`, `.md-rich`) auto-wait for it; a `getByTestId(...).click()` on a control
 * that follows a bare `waitForHydration` does not, so it goes through here (or `openDocument`).
 */
export async function waitForEditor(page: Page, timeout = 60_000) {
  await page.getByTestId("editor-shell").waitFor({ state: "attached", timeout });
}

/** Is the page on an editor URL (`/d/<id>`), where the shell loads after the server-rendered placeholder? */
const onEditorPage = (page: Page) => /^\/d\/[^/]+/.test(new URL(page.url()).pathname);

/** page.reload() that does not return until React is interactive again (on `/d/`, until the editor shell is in the DOM). */
export async function reloadHydrated(page: Page) {
  await page.reload();
  await waitForHydration(page);
  if (onEditorPage(page)) await waitForEditor(page);
}

/** Store a theme preference and reload; returns once the boot script applied it and React is interactive. */
export async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => localStorage.setItem("markdoc:theme", t), theme);
  await reloadHydrated(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Create a document through the API (faster and more reliable than clicking through). */
export async function createDocument(page: Page, content: string, title?: string): Promise<string> {
  const res = await page.request.post("/api/documents", { data: { content, title } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

export async function openDocument(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  // The server renders a placeholder; the shell (and `save-state` in its header) arrives with the editor chunks.
  await waitForEditor(page);
  const saveState = page.getByTestId("save-state");
  try {
    // 30 s is plenty once the dev server is warm (see e2e/global-setup.ts); do not raise it.
    await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  } catch (err) {
    const state = await saveState.getAttribute("data-state", { timeout: 1_000 }).catch(() => null);
    const header = await saveState.innerText({ timeout: 1_000 }).catch(() => "");
    throw new Error(
      `openDocument(${id}): save-state did not reach "saved" within 30 s — stuck in data-state=${
        state ?? "<missing>"
      } (header: "${header.trim()}")\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".md-rich")).toBeVisible();
}

export async function shareWith(page: Page, docId: string, login: string, role: "editor" | "commenter" | "viewer") {
  const res = await page.request.post(`/api/documents/${docId}/collaborators`, { data: { login, role } });
  expect(res.ok()).toBeTruthy();
}

export interface MintedToken {
  /** The bearer secret (`mdk_…`); the server shows it once. */
  token: string;
  id: string;
  /** The stored name, as the UI renders it (presence avatar, review card author, `@<login>/<slug>` mention). */
  name: string;
  /** `DELETE /api/tokens/<id>`; a 404 (already revoked by the test) is fine. Call it before the context closes. */
  revoke: () => Promise<void>;
}

/**
 * Mints an API token for the signed-in user and revokes it when the caller's group ends. Names are unique
 * per user (409 otherwise), so every spec gets its own: call `revoke()` from the group's `afterAll` (or at the
 * end of the test that minted) before `context.close()`, so the next spec that signs in as the same user can
 * mint the same name again. Playwright runs `afterAll` on a failure-induced worker restart too, so the
 * re-run `beforeAll` does not 409 either. Two spec files that share a user and a name still collide when
 * they run in parallel workers (CI runs two): give them distinct names.
 */
export async function mintToken(
  page: Page,
  name: string,
  opts: { expiresInDays?: number; scope?: "read" | "comment" | "full"; documentIds?: string[] } = {},
): Promise<MintedToken> {
  const res = await page.request.post("/api/tokens", { data: { name, ...opts } });
  const detail = res.ok() ? "" : ` ${await res.text()}`;
  expect(res.ok(), `POST /api/tokens name="${name}" -> ${res.status()}${detail}`).toBeTruthy();
  const { token } = (await res.json()) as { token: { id: string; name: string; token: string } };
  return {
    token: token.token,
    id: token.id,
    name: token.name,
    revoke: async () => {
      const del = await page.request.delete(`/api/tokens/${token.id}`);
      if (del.status() === 404) return;
      const why = del.ok() ? "" : ` ${await del.text()}`;
      expect(del.ok(), `DELETE /api/tokens/${token.id} (${name}) -> ${del.status()}${why}`).toBeTruthy();
    },
  };
}

/**
 * The shared Markdown text (what both panes render), read from the live session. A production build does not
 * expose the dev-only `__markdocSession` hook, so under PROD_BASE_URL a missing hook falls back to the code
 * pane's lines without remote caret labels; the regular suite still fails loudly when the hook is missing.
 */
export const codeText = (page: Page) =>
  page.evaluate((renderedFallback) => {
    const session = (window as unknown as { __markdocSession?: { ytext: { toString(): string } } }).__markdocSession;
    if (session || !renderedFallback) return session!.ytext.toString();
    return Array.from(document.querySelectorAll(".cm-content > .cm-line"), (line) => {
      const clone = line.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".cm-ySelectionCaret").forEach((n) => n.remove());
      return clone.textContent ?? "";
    }).join("\n");
  }, Boolean(process.env.PROD_BASE_URL));

/** Visible text of the rich pane without remote caret labels. */
export const richText = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector(".md-rich");
    if (!root) return "";
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".md-remote-caret").forEach((n) => n.remove());
    clone.style.position = "absolute";
    clone.style.left = "-99999px";
    document.body.appendChild(clone);
    const text = clone.innerText;
    clone.remove();
    return text;
  });

/**
 * Each suggestion's own joined insert text, read from `.md-rich .md-suggest-insert` spans and grouped by
 * the `data-highlight-id` attribute the rich-pane decorations carry (see highlights.ts: the id is the
 * suggestion's `groupId ?? id`). A collaborator's live cursor widget can render inline inside the mark
 * and split one suggestion into two sibling spans sharing the same id (#2239); joining by id proves the
 * text still belongs to ONE suggestion, unlike reading the whole document, while a remote-caret label
 * inside a span is stripped from a clone first so it never pollutes the joined text.
 */
export const suggestionInsertTexts = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector(".md-rich");
    if (!root) return [];
    const byId = new Map<string, string>();
    root.querySelectorAll(".md-suggest-insert").forEach((span) => {
      const id = span.getAttribute("data-highlight-id") ?? "";
      const clone = span.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".md-remote-caret").forEach((n) => n.remove());
      byId.set(id, (byId.get(id) ?? "") + (clone.textContent ?? ""));
    });
    return Array.from(byId.values());
  });

/**
 * Place the caret at the end of the rich editor's document. Clicks near the top-left of the first text
 * block, not the pane centre: on a fixture whose vertical middle is an image the centre click selects the
 * image node, `Control+End` stays on it and the caret never reaches text (a11y dark slash-menu flake).
 * Chromium handles `Control+End` natively and fires `selectionchange` in a later task (see clickEdgeOf),
 * so a key pressed right behind it is judged against ProseMirror's stale selection (`I` / paste /
 * `ntro paragraph.` in paste.spec); the state is polled until it holds a caret at the document end.
 */
export async function focusRichEnd(page: Page) {
  const rich = page.locator(".md-rich");
  const block = rich.locator("p, h1, h2, h3, h4, li, blockquote, pre").first();
  if ((await block.count()) === 0) await rich.click();
  else await block.click({ position: { x: 8, y: 8 } });
  for (let attempt = 1; ; attempt++) {
    await page.keyboard.press("Control+End");
    const atEnd = await expect
      .poll(() => pmCaretAtDocEnd(page), { timeout: 3_000 })
      .toBe(true)
      .then(() => true, () => false);
    if (atEnd) return;
    if (attempt >= 2) throw new Error(`caret never reached the end of the rich document after Control+End (twice): ${await pmCaretAtDocEnd(page)}`);
  }
}

/** Is the focused caret at the document end? Production uses the DOM because its state hook is absent. */
const pmCaretAtDocEnd = (page: Page) =>
  page.evaluate((renderedFallback) => {
    type View = { hasFocus(): boolean; state: { doc: { content: { size: number } }; selection: { empty: boolean; $head: { pos: number; depth: number } } } };
    const view = (window as unknown as { __markdocRichView?: View }).__markdocRichView;
    if (!view) {
      if (!renderedFallback) return "no view";
      const rich = document.querySelector(".md-rich");
      const blocks = rich?.querySelectorAll("p, h1, h2, h3, h4, h5, h6, pre");
      const lastBlock = blocks?.item(blocks.length - 1);
      const selection = window.getSelection();
      if (!rich || document.activeElement !== rich) return "editor not focused";
      if (!lastBlock || !selection?.isCollapsed || !selection.anchorNode || !lastBlock.contains(selection.anchorNode)) {
        return "caret not in the last text block";
      }
      const remainder = document.createRange();
      remainder.selectNodeContents(lastBlock);
      remainder.setStart(selection.anchorNode, selection.anchorOffset);
      // A collaborator's caret label (.md-remote-caret) can render as a sibling right after our own caret;
      // strip it from a clone before checking for leftover content, the same way `richText` strips it.
      // ProseMirror also adds an img.ProseMirror-separator next to a widget at the end of a block; it is
      // not content, so a real image after the caret must still count as content but that one must not.
      const fragment = remainder.cloneContents();
      fragment.querySelectorAll(".md-remote-caret").forEach((n) => n.remove());
      return (fragment.textContent ?? "") === "" &&
        !fragment.querySelector("img:not(.ProseMirror-separator), br:not(.ProseMirror-trailingBreak)")
        ? true
        : "content follows the caret";
    }
    if (!view.hasFocus()) return "editor not focused";
    const { doc, selection } = view.state;
    const { pos, depth } = selection.$head;
    // At the end of the last textblock every ancestor's closing token follows the caret: one per level of depth.
    return selection.empty && pos === doc.content.size - depth ? true : `selection ${pos} (depth ${depth}, empty ${selection.empty}) vs doc size ${doc.content.size}`;
  }, Boolean(process.env.PROD_BASE_URL));

export async function focusCodeEnd(page: Page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
}

export async function selectTextInRich(page: Page, text: string, { scrollIntoView = false }: { scrollIntoView?: boolean } = {}) {
  const rich = page.locator(".md-rich");
  // "Saved" can precede the deferred rich-pane rebuild, while the server-rendered stand-in is visible.
  await expect(rich).toBeVisible();
  await expect(rich).toContainText(text);
  const prod = Boolean(process.env.PROD_BASE_URL);
  await rich.evaluate(
    (root, [needle, waitForSelectionChange, scroll]) =>
      new Promise<void>((resolve, reject) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const idx = node.textContent!.indexOf(needle);
          if (idx >= 0) {
            // A real click/dblclick auto-scrolls its target into view; this synthetic Range selection does
            // not. Opt in with `scrollIntoView` when a target may be scrolled off-screen (e.g. below a table
            // from an earlier step), landing outside the selection bubble's visible-bounds check so it never
            // shows. Leave this off by default: scrollIntoView() also moves every scrollable ancestor, which
            // breaks callers that scroll the rich pane on purpose and then expect the selection to stay put.
            if (scroll) node.parentElement?.scrollIntoView({ block: "center" });
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + needle.length);
            if (waitForSelectionChange) document.addEventListener("selectionchange", () => requestAnimationFrame(() => resolve()), { once: true });
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            root.focus();
            if (!waitForSelectionChange) resolve();
            return;
          }
        }
        reject(new Error(`text not found: ${needle}`));
      }),
    [text, prod, scrollIntoView] as const,
  );
  // Let ProseMirror pick up the DOM selection (it reads it on `selectionchange`, a later task). A production
  // build waits for that event plus one frame above (there is no `__markdocRichView` hook there to poll
  // directly), then polls `pmSelectionSynced`: on a production build that is this exact-text DOM check; on
  // dev the `text` argument is ignored there and it instead compares ProseMirror's state against the DOM.
  await expect.poll(() => pmSelectionSynced(page, text), { message: `ProseMirror should read the selection of "${text}"` }).toBe(true);
}


/** GFM table lines (those starting with `|`) of the shared Markdown text. */
export const tableLines = async (page: Page) => (await codeText(page)).split("\n").filter((l) => l.trim().startsWith("|"));

/** Cell (r, c) of the rich pane's table: row index over `tr` (header row is 0), column index over `td,th`. */
export const tableCell = (page: Page, r: number, c: number) =>
  page.locator(".md-rich table tr").nth(r).locator("td,th").nth(c);

const caretInCell = (page: Page, r: number, c: number) =>
  page.evaluate(([row, col]) => {
    const target = document.querySelectorAll(".md-rich table tr")[row]?.querySelectorAll("td,th")[col];
    const anchor = window.getSelection()?.anchorNode ?? null;
    const active = document.activeElement;
    return Boolean(target && anchor && target.contains(anchor) && active && active.closest(".md-rich"));
  }, [r, c] as const);

/**
 * Put the caret in table cell (r, c) and wait until the DOM selection really sits inside it.
 * Table commands and shortcuts move the caret (a new row takes focus, a deleted row drops it
 * elsewhere), and under load the selection update races the next keypress; always call this
 * before typing or pressing a table shortcut so the keys land in the intended cell.
 */
export async function clickCell(page: Page, r: number, c: number) {
  const cell = tableCell(page, r, c);
  await expect(cell).toBeVisible();
  for (let attempt = 1; ; attempt++) {
    await cell.click();
    const landed = await expect
      .poll(() => caretInCell(page, r, c), { timeout: 3_000 })
      .toBe(true)
      .then(() => true, () => false);
    if (landed) break;
    if (attempt >= 3) throw new Error(`clickCell(${r}, ${c}): caret did not land in the cell after ${attempt} clicks`);
  }
  await expect(page.getByTestId("table-menu")).toBeVisible();
}

/**
 * Wait until the rich pane's table has `rows` rows (header included) of `cols` cells each AND
 * the code pane has the matching `rows + 1` GFM lines (header, delimiter, bodies). Call after
 * every structural table operation before acting on either pane again.
 */
export async function expectTableShape(page: Page, rows: number, cols: number) {
  const trs = page.locator(".md-rich table tr");
  await expect(trs).toHaveCount(rows);
  await expect
    .poll(() => trs.evaluateAll((els) => els.map((tr) => tr.querySelectorAll("td,th").length)), {
      message: `every row should have ${cols} cells`,
    })
    .toEqual(Array.from({ length: rows }, () => cols));
  await expect.poll(async () => (await tableLines(page)).length, { message: `code pane should have ${rows + 1} table lines` }).toBe(rows + 1);
}

/**
 * Does ProseMirror's *state* selection agree with the DOM selection? A key pressed while they
 * differ is judged against the stale state (the keymap declines or acts on the wrong block), so
 * every real-click helper waits for this before the test types. `__markdocRichView` is the dev-only
 * hook rich-pane.tsx sets next to `__markdocSession`. Production uses the DOM instead, since its state
 * hook is absent: when `text` is given, the DOM selection must be a real (non-collapsed) selection
 * inside `.md-rich` whose exact text is `text` - never just "something is selected". Without `text`
 * (the caret-only callers below, which already verified DOM position themselves) it only requires a
 * collapsed caret inside `.md-rich`.
 */
export const pmSelectionSynced = (page: Page, text?: string) =>
  page.evaluate(
    ([renderedFallback, needle]) => {
      type View = { hasFocus(): boolean; state: { selection: { anchor: number; head: number } }; posAtDOM(node: Node, offset: number): number };
      const view = (window as unknown as { __markdocRichView?: View }).__markdocRichView;
      const s = document.getSelection();
      if (!view) {
        if (!renderedFallback) return "no view";
        if (!s?.anchorNode || !s.focusNode) return "no DOM selection";
        const rich = document.querySelector(".md-rich");
        if (!rich || !rich.contains(s.anchorNode) || !rich.contains(s.focusNode)) return "selection outside .md-rich";
        if (needle === null) return s.isCollapsed ? true : "selection is not collapsed";
        if (s.isCollapsed) return "selection is collapsed, expected selected text";
        const selected = s.toString();
        return selected === needle ? true : `DOM selection "${selected}" vs expected "${needle}"`;
      }
      if (!s?.anchorNode || !s.focusNode) return "no view or no DOM selection";
      if (!view.hasFocus()) return "editor not focused";
      let anchor: number, head: number;
      try {
        anchor = view.posAtDOM(s.anchorNode, s.anchorOffset);
        head = view.posAtDOM(s.focusNode, s.focusOffset);
      } catch (e) {
        return `DOM selection outside the editor: ${String(e)}`;
      }
      const { selection } = view.state;
      return selection.anchor === anchor && selection.head === head ? true : `state ${selection.anchor}-${selection.head} vs DOM ${anchor}-${head}`;
    },
    [Boolean(process.env.PROD_BASE_URL), text ?? null] as const,
  );

/**
 * Put the caret at the start or end of the text of the first element matching `selector`, with a
 * real mouse click, and wait until the DOM selection sits there AND ProseMirror has read it. A click
 * is the only placement ProseMirror picks up synchronously: after a natively handled `Home` (or
 * `Control+Home`, which goes to the document start, not the block start) Chromium fires
 * `selectionchange` in a later task, so a key pressed right behind it is judged against
 * ProseMirror's stale selection, the keymap declines it and the browser merges blocks natively
 * (`# H1A quote line.` in the lead's run). Even after a click the state can lag the DOM under load
 * (Ctrl+Enter in a task item fell through to a hard break in the previous item, task #437), so the
 * state is polled too, and the click is retried once if it never catches up.
 */
export async function clickEdgeOf(page: Page, selector: string, edge: "start" | "end") {
  const el = page.locator(`.md-rich ${selector}`).first();
  await expect(el).toBeVisible();
  const domCaretAtEdge = () =>
    page.evaluate(
      ([sel, side]) => {
        const s = document.getSelection();
        const block = s?.anchorNode?.parentElement?.closest(sel);
        if (!block || !s || !s.isCollapsed) return "no caret";
        const range = document.createRange();
        range.selectNodeContents(block);
        range.setEnd(s.anchorNode!, s.anchorOffset);
        const before = range.toString().length;
        return side === "start" ? before === 0 : before === block.textContent!.length;
      },
      [`.md-rich ${selector}`, edge] as const,
    );
  for (let attempt = 1; ; attempt++) {
    const point = await el.evaluate((node, side) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      const rect = (side === "start" ? rects[0] : rects[rects.length - 1]) ?? range.getBoundingClientRect();
      return { x: side === "start" ? rect.left + 1 : rect.right - 1, y: rect.top + rect.height / 2 };
    }, edge);
    await page.mouse.click(point.x, point.y);
    await expect.poll(domCaretAtEdge, { message: `caret should be at the ${edge} of ${selector}` }).toBe(true);
    const synced = await expect
      .poll(() => pmSelectionSynced(page), { timeout: 3_000 })
      .toBe(true)
      .then(() => true, () => false);
    if (synced) return;
    if (attempt >= 2) throw new Error(`clickEdgeOf(${selector}, ${edge}): ProseMirror never read the clicked selection: ${await pmSelectionSynced(page)}`);
  }
}

/** Caret path inside .md-rich (e.g. "blockquote>p") from the DOM selection. */
export const caretPath = (page: Page) =>
  page.evaluate(() => {
    const sel = document.getSelection();
    let el = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    const path: string[] = [];
    while (el && !el.classList.contains("md-rich")) {
      path.unshift(el.tagName.toLowerCase());
      el = el.parentElement;
    }
    return path.join(">");
  });

/**
 * Gap between the first `.md-rich > prev` and its next sibling, that sibling's margin-top, and the
 * rhythm token it should resolve to. The tokens are em values resolved on the element they land on
 * (globals.css "Markdown prose rhythm", task #346): the first block under a heading hugs it with
 * --md-space-heading-after, a heading takes its per-level margin-top (an h2 keeps 0.6em of it as
 * padding so the border sits closer to the text), a thematic break gets 1.75 x --md-space on both
 * sides, everything else gets --md-space.
 */
export async function gapAfter(page: Page, prev: string) {
  return page.locator(`.md-rich > ${prev}`).first().evaluate((el) => {
    const next = el.nextElementSibling as HTMLElement | null;
    if (!next) throw new Error(`nothing after ${el.tagName}`);
    const a = el.getBoundingClientRect();
    const b = next.getBoundingClientRect();
    const prevTag = el.tagName.toLowerCase();
    const nextTag = next.tagName.toLowerCase();
    let token = "--md-space";
    let factor = 1;
    let minusEm = 0;
    if (/^h[1-6]$/.test(prevTag)) token = "--md-space-heading-after";
    else if (nextTag === "h1") token = "--md-space-heading-before-h2";
    else if (nextTag === "h2") {
      token = "--md-space-heading-before-h2";
      minusEm = 0.6;
    } else if (nextTag === "h3") token = "--md-space-heading-before-h3";
    else if (/^h[4-6]$/.test(nextTag)) token = "--md-space-heading-before-h4";
    else if (prevTag === "hr" || nextTag === "hr") factor = 1.75;
    const root = el.closest(".md-rich")!;
    const em = parseFloat(getComputedStyle(root).getPropertyValue(token));
    const fontSize = parseFloat(getComputedStyle(next).fontSize);
    return { next: nextTag, gap: b.top - a.bottom, marginTop: parseFloat(getComputedStyle(next).marginTop), token, expected: (em * factor - minusEm) * fontSize };
  });
}

export async function expectRhythm(page: Page, prev: string, next: string) {
  const g = await gapAfter(page, prev);
  expect(g.next, `${prev} is followed by ${next}`).toBe(next);
  expect(Math.abs(g.marginTop - g.expected), `the block after ${prev} gets ${g.token} (${g.expected.toFixed(1)} px), got ${g.marginTop.toFixed(1)} px`).toBeLessThan(0.5);
  expect(Math.abs(g.gap - g.marginTop), `gap after ${prev} (${g.gap.toFixed(1)} px) equals the margin-top (${g.marginTop.toFixed(1)} px)`).toBeLessThan(1);
}

/** Open the comments side panel if it is not already visible. */
export async function ensureCommentsOpen(page: Page) {
  // The toggle lives in the shell's header, which mounts after the placeholder: clicked before that, there is nothing to click.
  await waitForEditor(page);
  if ((await page.getByTestId("comments-panel").count()) === 0) {
    await page.getByTestId("comments-toggle").click();
  }
  await expect(page.getByTestId("comments-panel")).toBeVisible();
}

/** Phone width has no code pane, so `openDocument` (which waits for CodeMirror) does not apply: open the document and its Comments sheet. */
export async function openPhoneComments(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.locator(".md-rich")).toBeVisible();
  await page.getByTestId("comments-toggle").click();
  await expect(page.getByTestId("comments-panel")).toBeVisible();
}

export type CommentsTab = "open" | "resolved" | "suggestions";

/** The comments panel shows exactly `tab`: it alone is selected and the tab stop, and the tab panel is labelled by it. */
export async function expectCommentsTab(page: Page, tab: CommentsTab, { focused = false }: { focused?: boolean } = {}) {
  for (const id of ["open", "resolved", "suggestions"] as const) {
    const el = page.getByTestId(`comments-tab-${id}`);
    await expect(el).toHaveAttribute("aria-selected", String(id === tab));
    await expect(el).toHaveAttribute("tabindex", id === tab ? "0" : "-1");
  }
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", `comments-tab-${tab}`);
  if (focused) await expect(page.getByTestId(`comments-tab-${tab}`)).toBeFocused();
}

/** The Settings theme picker has `preference` checked, focused and as its only tab stop, and it is saved. */
export async function expectThemeOption(page: Page, preference: "system" | "light" | "dark") {
  for (const id of ["system", "light", "dark"] as const) {
    const el = page.getByTestId(`theme-option-${id}`);
    await expect(el).toHaveAttribute("aria-checked", String(id === preference));
    await expect(el).toHaveAttribute("tabindex", id === preference ? "0" : "-1");
  }
  await expect(page.getByTestId(`theme-option-${preference}`)).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("markdoc:theme"))).toBe(preference);
}
