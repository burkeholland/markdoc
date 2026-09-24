import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { budgetMs, codeText, createDocument, focusRichEnd, openDocument, richText, shareWith, signIn } from "./helpers";
import { CONTENT_AUTOSAVE_IDLE_MS } from "../src/lib/document-persistence";

/** 40 letters at 120 ms each: about five seconds of typing at a normal pace. */
const TYPED = Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
const CONTENT = "# Save indicator\n\nA paragraph.\n";

interface PillChange {
  attr: "data-state" | "data-live-state";
  value: string;
  t: number;
}

type PillWindow = Window & { __pillChanges?: PillChange[] };

/** Installs a MutationObserver that records every `data-state` and `data-live-state` the save pill goes through. */
async function observePill(page: Page) {
  await page.evaluate(() => {
    const w = window as PillWindow;
    const el = document.querySelector('[data-testid="save-state"]');
    if (!el) throw new Error("save-state pill not found");
    const list: PillChange[] = [];
    w.__pillChanges = list;
    const previous = new Map<PillChange["attr"], string | null>([
      ["data-state", el.getAttribute("data-state")],
      ["data-live-state", el.getAttribute("data-live-state")],
    ]);
    new MutationObserver(() => {
      const current = document.querySelector('[data-testid="save-state"]');
      if (!current) return;
      const t = performance.now();
      for (const attr of ["data-state", "data-live-state"] as const) {
        const value = current.getAttribute(attr) ?? "<missing>";
        if (value === previous.get(attr)) continue;
        previous.set(attr, value);
        list.push({ attr, value, t });
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "data-live-state"] });
  });
}

const pillChanges = (page: Page) => page.evaluate(() => (window as PillWindow).__pillChanges ?? []);
const now = (page: Page) => page.evaluate(() => performance.now());

async function storedAt(page: Page, docId: string): Promise<string> {
  const response = await page.request.get(`/api/documents/${docId}`);
  expect(response.ok()).toBe(true);
  const body = await response.json() as { document: { updatedAt: string } };
  return body.document.updatedAt;
}

test("continuous typing stays dirty until actual trailing-idle persistence", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Save indicator: one typist");
    await openDocument(alice.page, docId);
    await focusRichEnd(alice.page);
    const before = await storedAt(alice.page, docId);
    await observePill(alice.page);

    await alice.page.keyboard.type(TYPED, { delay: 120 });
    const typedEnd = await now(alice.page);
    expect(await storedAt(alice.page, docId)).toBe(before);
    const pill = alice.page.getByTestId("save-state");
    await expect(pill).toHaveAttribute("data-state", "saved");
    await expect.poll(() => codeText(alice.page)).toContain(TYPED);

    const changes = await pillChanges(alice.page);
    const live = changes.filter((c) => c.attr === "data-live-state");
    const shown = changes.filter((c) => c.attr === "data-state");
    const settle = shown[shown.length - 1];
    expect(settle).toBeDefined();
    console.log(
      `[save-indicator T1] live-state changes ${live.length}, durable-state changes ${shown.length}, ` +
        `Saved ${Math.round(settle.t - typedEnd)} ms after typing`,
    );

    expect(shown.filter((change) => change.value === "saved")).toHaveLength(1);
    expect(shown.some((change) => change.value === "pending")).toBe(true);
    expect(live.map((change) => change.value)).toEqual(shown.map((change) => change.value));
    expect(settle.t - typedEnd).toBeGreaterThanOrEqual(CONTENT_AUTOSAVE_IDLE_MS - 200);
    expect(settle.t - typedEnd).toBeLessThanOrEqual(budgetMs(3_000));
    expect(await storedAt(alice.page, docId)).not.toBe(before);
    await openDocument(alice.page, docId);
    await expect.poll(() => codeText(alice.page)).toContain(TYPED);
  } finally {
    await alice.context.close();
  }
});

test("another user receives edits before the typing burst is persisted", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  const bob = await signIn(browser, "bob");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Save indicator: two users");
    await shareWith(alice.page, docId, bob.login, "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
    const before = await codeText(alice.page);
    const persistedBefore = await storedAt(alice.page, docId);
    await focusRichEnd(bob.page);
    await observePill(alice.page);

    const firstHalf = TYPED.slice(0, 20);
    await bob.page.keyboard.type(firstHalf, { delay: 120 });
    await expect.poll(() => codeText(alice.page), { timeout: budgetMs(500) }).toContain(firstHalf);
    expect(await storedAt(alice.page, docId)).toBe(persistedBefore);
    await bob.page.keyboard.type(TYPED.slice(20), { delay: 120 });
    await expect(bob.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => richText(alice.page)).toContain(TYPED);
    await expect.poll(() => codeText(alice.page)).toContain(TYPED);

    const changes = await pillChanges(alice.page);
    const live = changes.filter((c) => c.attr === "data-live-state");
    const shown = changes.filter((c) => c.attr === "data-state");
    const after = await codeText(alice.page);
    console.log(`[save-indicator T2] alice data-state changes ${shown.length}, live-state changes ${live.length}, content delivered ${after !== before && after.includes(TYPED)}`);

    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-live-state", "saved");
    expect(after).not.toBe(before);
    expect(await storedAt(alice.page, docId)).not.toBe(persistedBefore);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

test("manual Save flushes the current edit and synthetic composition holds autosave", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Save indicator: manual and composition");
    await openDocument(alice.page, docId);
    await focusRichEnd(alice.page);
    const before = await storedAt(alice.page, docId);
    await alice.page.keyboard.type(" manual-save");
    await alice.page.getByRole("button", { name: "Save document", exact: true }).click();
    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    const manualSaved = await storedAt(alice.page, docId);
    expect(manualSaved).not.toBe(before);

    await focusRichEnd(alice.page);
    const rich = alice.page.locator(".md-rich");
    await rich.dispatchEvent("compositionstart", { data: "" });
    await alice.page.keyboard.insertText("\u3042");
    await alice.page.waitForTimeout(CONTENT_AUTOSAVE_IDLE_MS + 500);
    expect(await storedAt(alice.page, docId)).toBe(manualSaved);
    await rich.dispatchEvent("compositionend", { data: "\u3042" });
    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    expect(await storedAt(alice.page, docId)).not.toBe(manualSaved);
    await openDocument(alice.page, docId);
    await expect.poll(() => codeText(alice.page)).toContain("manual-save\u3042");
  } finally {
    await alice.context.close();
  }
});
