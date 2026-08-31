import { test, expect, type Page } from "@playwright/test";
import { codeText, createDocument, focusRichEnd, openDocument, richText, shareWith, signIn } from "./helpers";

/**
 * The header's save chip while typing (#1282). The provider counts one unsynced change per keystroke and
 * the server acks each within tens of ms, so the raw state (`data-live-state`) alternates saving/saved on
 * every key. The chip itself (`data-state`) must read "Saving…" steadily for as long as you type and flip
 * to "Saved" once, about a second after the last ack; another user's typing must not move your chip at all
 * while their words still arrive live.
 */

/** Mirrors `SAVED_HOLD_MS` in src/components/editor/use-session.ts. */
const SAVED_HOLD_MS = 1000;
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
    new MutationObserver((records) => {
      const t = performance.now();
      for (const r of records) {
        const attr = r.attributeName as PillChange["attr"];
        const value = el.getAttribute(attr) ?? "<missing>";
        if (value === r.oldValue) continue;
        list.push({ attr, value, t });
      }
    }).observe(el, { attributes: true, attributeOldValue: true, attributeFilter: ["data-state", "data-live-state"] });
  });
}

const pillChanges = (page: Page) => page.evaluate(() => (window as PillWindow).__pillChanges ?? []);
const now = (page: Page) => page.evaluate(() => performance.now());

test("one user typing: the chip flips twice while the sync still runs per keystroke", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Save indicator: one typist");
    await openDocument(alice.page, docId);
    await focusRichEnd(alice.page);
    await observePill(alice.page);

    await alice.page.keyboard.type(TYPED, { delay: 120 });
    const typedEnd = await now(alice.page);
    const pill = alice.page.getByTestId("save-state");
    await expect(pill).toHaveAttribute("data-state", "saved");
    await expect.poll(() => codeText(alice.page)).toContain(TYPED);

    const changes = await pillChanges(alice.page);
    const live = changes.filter((c) => c.attr === "data-live-state");
    const shown = changes.filter((c) => c.attr === "data-state");
    const settle = shown[shown.length - 1];
    const lastAck = live[live.length - 1];
    console.log(
      `[save-indicator T1] live-state changes ${live.length}, data-state changes ${shown.length} (${shown.map((c) => c.value).join("→")}), ` +
        `Saved ${Math.round(settle.t - lastAck.t)} ms after the last ack, ${Math.round(settle.t - typedEnd)} ms after the last keystroke`,
    );

    // The sync is untouched: the raw state still moves for (nearly) every key.
    expect(live.length).toBeGreaterThanOrEqual(10);
    expect(live[0].value).toBe("saving");
    expect(lastAck.value).toBe("saved");
    // The chip moved exactly twice: into Saving… at the first key, back to Saved once after the hold.
    expect(shown.map((c) => c.value)).toEqual(["saving", "saved"]);
    expect(settle.t - lastAck.t).toBeGreaterThanOrEqual(SAVED_HOLD_MS - 100);
    expect(settle.t - typedEnd).toBeLessThanOrEqual(3_000);
    // Saving… showed at the first key, not after a delay.
    expect(shown[0].t).toBeLessThanOrEqual(live[0].t + 200);
  } finally {
    await alice.context.close();
  }
});

test("two users, only one types: the other's chip does not move while the words arrive", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  const bob = await signIn(browser, "bob");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Save indicator: two users");
    await shareWith(alice.page, docId, bob.login, "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
    const before = await codeText(alice.page);
    await focusRichEnd(bob.page);
    await observePill(alice.page);

    await bob.page.keyboard.type(TYPED, { delay: 120 });
    await expect(bob.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => richText(alice.page)).toContain(TYPED);
    await expect.poll(() => codeText(alice.page)).toContain(TYPED);

    const changes = await pillChanges(alice.page);
    const live = changes.filter((c) => c.attr === "data-live-state");
    const shown = changes.filter((c) => c.attr === "data-state");
    const after = await codeText(alice.page);
    console.log(`[save-indicator T2] alice data-state changes ${shown.length}, live-state changes ${live.length}, content delivered ${after !== before && after.includes(TYPED)}`);

    expect(shown).toEqual([]);
    expect(live).toEqual([]);
    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-live-state", "saved");
    expect(after).not.toBe(before);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
