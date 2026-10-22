import { mcpURL } from "./mcp-url";
import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import {
  signIn,
  createDocument,
  openDocument,
  shareWith,
  selectTextInRich,
  ensureCommentsOpen,
  codeText,
  focusRichEnd,
  mintToken,
  uniqueLogin,
  type MintedToken,
  type User,
} from "./helpers";

/**
 * Every suggestion decision control, driven by real input: a mouse click, and Enter / Space on the focused
 * button (#2212). Accept, Reject, Accept all and Reject all used to drop real clicks and keys, so the
 * suggestion stayed pending and the document never changed.
 *
 * "local" = Alice (who decides) made the suggestion herself; "remote" = Bob made it in his own browser.
 * Runs on the dev server, and on a production build with PROD_BASE_URL set (the code pane is read through
 * `codeText`, which falls back to the rendered lines when the dev-only session hook is absent, and the rich
 * selection is placed with `selectTextInRich` / `caretAfter`, which do not need the dev-only editor hook there).
 */

const SOURCE = "# Actions\n\nOur product is very unique.\n\nSales are good.\n\nThe end is near.\n";
const AGENT = "Copilot Actions";
/** A real decision lands at once; a dropped click never does. Keeps a failing matrix fast. */
const DECIDED_MS = 5_000;

type Input = "click" | "Enter" | "Space";
type Origin = "local" | "remote";
const INPUTS: readonly Input[] = ["click", "Enter", "Space"];
const ORIGINS: readonly Origin[] = ["local", "remote"];

async function activate(button: Locator, input: Input) {
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  if (input === "click") {
    await button.click();
    return;
  }
  await button.focus();
  await expect(button).toBeFocused();
  await button.page().keyboard.press(input);
}

/** JSON-RPC over the MCP server, the way Copilot CLI calls the HTTP server. */
async function mcp<T>(page: Page, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await page.request.post(mcpURL(), {
    headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.ok(), `${name} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const text = await res.text();
  const line = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5) : text;
  const body = JSON.parse(line) as { result: { structuredContent?: T; content: { text: string }[]; isError?: boolean } };
  expect(body.result.isError, body.result.content?.[0]?.text).toBeFalsy();
  return (body.result.structuredContent ?? JSON.parse(body.result.content[0].text)) as T;
}

const PROD = Boolean(process.env.PROD_BASE_URL);

/** Caret at the end of `text` in the rich pane (the start of the next typed words). */
async function caretAfter(page: Page, text: string) {
  await selectTextInRich(page, text);
  if (!PROD) {
    await page.keyboard.press("End");
    return;
  }
  // Arm the wait before the key, so the browser's `selectionchange` for the collapse is not missed.
  await page.evaluate(() => {
    (window as unknown as { __caretMoved?: Promise<void> }).__caretMoved = new Promise<void>((resolve) =>
      document.addEventListener("selectionchange", () => requestAnimationFrame(() => resolve()), { once: true }),
    );
  });
  await page.keyboard.press("ArrowRight");
  await page.evaluate(() => (window as unknown as { __caretMoved?: Promise<void> }).__caretMoved);
  await expect
    .poll(() =>
      page.evaluate((needle) => {
        const sel = window.getSelection();
        const node = sel?.focusNode;
        return Boolean(sel?.isCollapsed && node?.nodeType === Node.TEXT_NODE && node.textContent!.slice(0, sel.focusOffset).endsWith(needle));
      }, text),
    )
    .toBe(true);
}

/** Caret at the end of the rich document. */
async function caretAtEnd(page: Page) {
  if (!PROD) return focusRichEnd(page);
  await caretAfter(page, "The end is near.");
}

async function switchToSuggesting(page: Page) {
  await page.getByTestId("mode-switcher").click();
  await page.getByRole("menuitemradio", { name: /Suggesting/ }).click();
  await expect(page.getByTestId("mode-switcher")).toContainText("Suggesting");
}

/** A comment on `quote` whose body carries a ```suggestion block proposing `replacement`. */
async function commentSuggestion(page: Page, quote: string, replacement: string, body: string) {
  await selectTextInRich(page, quote);
  await page.getByTestId("tb-comment").click();
  await expect(page.getByTestId("pending-comment").getByTestId("comment-quote")).toHaveText(quote);
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toBeFocused();
  await composer.fill(`${body}\n\n\`\`\`suggestion\n${replacement}\n\`\`\``);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("comment-thread").filter({ hasText: body })).toHaveCount(1);
}

test.describe("suggestion Accept / Reject / Accept all / Reject all with real clicks and keys (#2212)", () => {
  let alice: User;
  let bob: User;
  let minted: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, uniqueLogin("acts-alice"));
    bob = await signIn(browser, uniqueLogin("acts-bob"));
    minted = await mintToken(alice.page, `${AGENT} ${Date.now().toString(36)}`, { expiresInDays: 1 });
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice?.context.close();
    await bob?.context.close();
  });

  /** Alice owns, Bob edits; both have the document open. The comments panel stays closed. */
  async function freshDocument(): Promise<string> {
    const docId = await createDocument(alice.page, SOURCE, "Actions");
    await shareWith(alice.page, docId, bob.login, "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
    return docId;
  }

  test.describe("comment suggestion (root): Accept / Reject on the card", () => {
    for (const origin of ORIGINS) {
      for (const action of ["accept", "reject"] as const) {
        for (const input of INPUTS) {
          test(`${origin} | ${action} | ${input}`, async () => {
            await freshDocument();
            const author = origin === "local" ? alice : bob;
            await ensureCommentsOpen(author.page);
            await commentSuggestion(author.page, "very unique", "unique", "Redundant.");
            const page = alice.page;
            await ensureCommentsOpen(page);
            const thread = page.getByTestId("comment-thread").filter({ hasText: "Redundant." }).first();
            await expect(thread).toHaveAttribute("data-suggestion", "pending");

            await activate(thread.getByTestId(action === "accept" ? "suggestion-accept-comment" : "suggestion-reject-comment"), input);

            if (action === "accept") {
              // Accepting resolves the thread, so it moves from the Open tab to the Resolved tab.
              await expect(thread).toHaveCount(0, { timeout: DECIDED_MS });
              await page.getByTestId("comments-tab-resolved").click();
            }
            await expect(thread).toHaveAttribute("data-suggestion", action === "accept" ? "accepted" : "rejected", { timeout: DECIDED_MS });
            await expect(thread.getByTestId("suggestion-accept-comment")).toHaveCount(0);
            await expect(thread.getByTestId("suggestion-reject-comment")).toHaveCount(0);
            if (action === "accept") await expect.poll(() => codeText(page)).toContain("Our product is unique.");
            else expect(await codeText(page)).toContain("Our product is very unique.");
          });
        }
      }
    }
  });

  test.describe("comment suggestion (agent reply): Accept / Reject on the reply", () => {
    for (const action of ["accept", "reject"] as const) {
      for (const input of INPUTS) {
        test(`remote | ${action} | ${input}`, async () => {
          const docId = await freshDocument();
          await ensureCommentsOpen(bob.page);
          await selectTextInRich(bob.page, "Sales are good");
          await bob.page.getByTestId("tb-comment").click();
          await expect(bob.page.getByTestId("pending-comment").getByTestId("comment-quote")).toHaveText("Sales are good");
          await bob.page.getByTestId("comment-composer").fill("Can an agent tighten this?");
          await bob.page.keyboard.press("ControlOrMeta+Enter");
          const authored = bob.page.getByTestId("comment-thread").filter({ hasText: "Can an agent tighten this?" }).first();
          await expect(authored).toBeVisible();
          const threadId = (await authored.getAttribute("data-thread-id"))!;
          const { id: replyId } = await mcp<{ id: string }>(alice.page, minted!.token, "markdoc_comment", {
            id: docId,
            action: "reply",
            threadId,
            body: "Tighter.\n\n```suggestion\nSales are strong\n```",
          });
          const page = alice.page;
          await ensureCommentsOpen(page);
          const reply = page.locator(`[data-testid="comment-reply"][data-reply-id="${replyId}"]`);
          await expect(reply).toHaveAttribute("data-state", "pending");

          await activate(reply.getByTestId(action === "accept" ? "suggestion-accept-comment" : "suggestion-reject-comment"), input);

          await expect(reply).toHaveAttribute("data-state", action === "accept" ? "accepted" : "rejected", { timeout: DECIDED_MS });
          if (action === "accept") await expect.poll(() => codeText(page)).toContain("Sales are strong.");
          else expect(await codeText(page)).toContain("Sales are good.");
        });
      }
    }
  });

  test.describe("tracked suggestions (Suggesting mode): Accept all / Reject all in the Suggestions tab", () => {
    /**
     * Two tracked insertions by the origin's author, then Alice opens the panel in Suggesting mode, so it
     * lands on the Suggestions tab without a tab click.
     */
    async function twoTrackedSuggestions(origin: Origin) {
      await freshDocument();
      const author = origin === "local" ? alice : bob;
      await switchToSuggesting(author.page);
      await caretAtEnd(author.page);
      await author.page.keyboard.type(" closing-words");
      await expect.poll(() => codeText(author.page)).toContain("near. closing-words");
      await caretAfter(author.page, "Sales are good.");
      await author.page.keyboard.type(" middle-words");
      const page = alice.page;
      await expect.poll(() => codeText(page)).toContain("near. closing-words");
      await expect.poll(() => codeText(page)).toContain("good. middle-words");
      if (origin === "remote") await switchToSuggesting(page);
      await ensureCommentsOpen(page);
      await expect(page.getByTestId("comments-tab-suggestions")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*2$/);
      await expect(page.getByTestId("suggestion-card")).toHaveCount(2);
      return page;
    }

    for (const origin of ORIGINS) {
      for (const action of ["accept", "reject"] as const) {
        for (const input of INPUTS) {
          test(`${origin} | ${action} all | ${input}`, async () => {
            const page = await twoTrackedSuggestions(origin);

            await activate(page.getByTestId(action === "accept" ? "accept-all" : "reject-all"), input);

            await expect(page.getByTestId("suggestion-card")).toHaveCount(0, { timeout: DECIDED_MS });
            await expect(page.locator(".md-rich .md-suggest-insert")).toHaveCount(0);
            const text = await codeText(page);
            if (action === "accept") {
              expect(text).toContain("near. closing-words");
              expect(text).toContain("good. middle-words");
            } else {
              expect(text).not.toContain("closing-words");
              expect(text).not.toContain("middle-words");
            }
          });
        }
      }
    }

    // Control: the per-card buttons are plain onClick handlers and are expected to work on main.
    for (const origin of ORIGINS) {
      for (const action of ["accept", "reject"] as const) {
        test(`${origin} | card ${action} | click`, async () => {
          const page = await twoTrackedSuggestions(origin);
          const card = page.getByTestId("suggestion-card").filter({ hasText: "closing-words" });
          await activate(card.getByTestId(action === "accept" ? "suggestion-accept" : "suggestion-reject"), "click");
          await expect(page.getByTestId("suggestion-card")).toHaveCount(1, { timeout: DECIDED_MS });
          if (action === "accept") expect(await codeText(page)).toContain("near. closing-words");
          else expect(await codeText(page)).not.toContain("closing-words");
        });
      }
    }
  });

  test.describe("mixed batch: Accept all / Reject all decide tracked and comment suggestions together", () => {
    for (const action of ["accept", "reject"] as const) {
      test(`remote | ${action} all | click`, async () => {
        await freshDocument();
        await ensureCommentsOpen(bob.page);
        await commentSuggestion(bob.page, "very unique", "unique", "Redundant.");
        await switchToSuggesting(bob.page);
        await caretAtEnd(bob.page);
        await bob.page.keyboard.type(" closing-words");
        const page = alice.page;
        await expect.poll(() => codeText(page)).toContain("near. closing-words");
        await switchToSuggesting(page);
        await ensureCommentsOpen(page);
        await expect(page.getByTestId("comments-tab-suggestions")).toHaveAttribute("aria-selected", "true");
        await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*2$/);

        await activate(page.getByTestId(action === "accept" ? "accept-all" : "reject-all"), "click");

        await expect(page.getByTestId("suggestion-card")).toHaveCount(0, { timeout: DECIDED_MS });
        await expect(page.getByTestId("comment-thread").filter({ hasText: "Redundant." })).toHaveCount(0);
        const text = await codeText(page);
        if (action === "accept") {
          expect(text).toContain("Our product is unique.");
          expect(text).toContain("near. closing-words");
        } else {
          expect(text).toContain("Our product is very unique.");
          expect(text).not.toContain("closing-words");
        }
      });
    }
  });

  test.describe("agent review card: Accept all / Reject all", () => {
    for (const action of ["accept", "reject"] as const) {
      test(`remote | review ${action} all | click`, async () => {
        const docId = await freshDocument();
        await mcp(alice.page, minted!.token, "markdoc_review", {
          id: docId,
          verdict: "request_changes",
          summary: "Two edits.",
          comments: [
            { quote: "very unique", body: "Redundant.\n\n```suggestion\nunique\n```" },
            { quote: "The end is near.", body: "Softer.\n\n```suggestion\nThat is all.\n```" },
          ],
        });
        const page = alice.page;
        await ensureCommentsOpen(page);
        const card = page.getByTestId("review-card").first();
        await expect(card).toBeVisible();

        await activate(card.getByTestId(action === "accept" ? "review-accept-all" : "review-reject-all"), "click");

        if (action === "accept") {
          // Accepting resolves both threads, so the card leaves the Open list; the document is the evidence.
          await expect.poll(() => codeText(page), { timeout: DECIDED_MS }).toContain("Our product is unique.");
          expect(await codeText(page)).toContain("That is all.");
        } else {
          await expect(card.getByTestId("review-counts")).toContainText("all decided", { timeout: DECIDED_MS });
          const text = await codeText(page);
          expect(text).toContain("Our product is very unique.");
          expect(text).toContain("The end is near.");
        }
      });
    }
  });
});
