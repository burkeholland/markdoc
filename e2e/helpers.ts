import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export interface User {
  context: BrowserContext;
  page: Page;
  login: string;
}

/** Multiplier for every timing budget: `E2E_BUDGET_SCALE` (a number ≥ 1), else 3 on CI, else 1. */
export const budgetScale = (): number => {
  const raw = Number(process.env.E2E_BUDGET_SCALE);
  return Number.isFinite(raw) && raw >= 1 ? raw : process.env.CI ? 3 : 1;
};

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
export const budgetMs = (ms: number): number => Math.round(ms * budgetScale());

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
 */
export async function waitForHydration(page: Page, timeout = 30_000) {
  await page.locator("html[data-hydrated]").waitFor({ state: "attached", timeout });
}

/** page.reload() that does not return until React is interactive again. */
export async function reloadHydrated(page: Page) {
  await page.reload();
  await waitForHydration(page);
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

/** The shared Markdown text (what both panes render), read from the live session. */
export const codeText = (page: Page) =>
  page.evaluate(() => (window as unknown as { __markdocSession: { ytext: { toString(): string } } }).__markdocSession.ytext.toString());

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

/** Is ProseMirror's *state* selection a focused caret at the very end of the document? (true, or why not) */
const pmCaretAtDocEnd = (page: Page) =>
  page.evaluate(() => {
    type View = { hasFocus(): boolean; state: { doc: { content: { size: number } }; selection: { empty: boolean; $head: { pos: number; depth: number } } } };
    const view = (window as unknown as { __markdocRichView?: View }).__markdocRichView;
    if (!view) return "no view";
    if (!view.hasFocus()) return "editor not focused";
    const { doc, selection } = view.state;
    const { pos, depth } = selection.$head;
    // At the end of the last textblock every ancestor's closing token follows the caret: one per level of depth.
    return selection.empty && pos === doc.content.size - depth ? true : `selection ${pos} (depth ${depth}, empty ${selection.empty}) vs doc size ${doc.content.size}`;
  });

export async function focusCodeEnd(page: Page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
}

export async function selectTextInRich(page: Page, text: string) {
  const rich = page.locator(".md-rich");
  // "Saved" can precede the deferred rich-pane rebuild, while the server-rendered stand-in is visible.
  await expect(rich).toBeVisible();
  await expect(rich).toContainText(text);
  await rich.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const idx = node.textContent!.indexOf(needle);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        root.focus();
        return;
      }
    }
    throw new Error(`text not found: ${needle}`);
  }, text);
  // Let ProseMirror pick up the DOM selection (it reads it on `selectionchange`, a later task).
  await expect.poll(() => pmSelectionSynced(page), { message: `ProseMirror should read the selection of "${text}"` }).toBe(true);
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
 * hook rich-pane.tsx sets next to `__markdocSession`.
 */
export const pmSelectionSynced = (page: Page) =>
  page.evaluate(() => {
    type View = { hasFocus(): boolean; state: { selection: { anchor: number; head: number } }; posAtDOM(node: Node, offset: number): number };
    const view = (window as unknown as { __markdocRichView?: View }).__markdocRichView;
    const s = document.getSelection();
    if (!view || !s?.anchorNode || !s.focusNode) return "no view or no DOM selection";
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
  });

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
  // The toggle is server-rendered without a handler: clicked before hydration, the panel simply stays closed.
  await waitForHydration(page);
  if ((await page.getByTestId("comments-panel").count()) === 0) {
    await page.getByTestId("comments-toggle").click();
  }
  await expect(page.getByTestId("comments-panel")).toBeVisible();
}
