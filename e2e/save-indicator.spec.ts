import { test, expect } from "./fixtures";
import type { Browser, Page } from "@playwright/test";
import { budgetMs, codeText, createDocument, focusCodeEnd, focusRichEnd, openDocument, richText, shareWith, signIn, waitForHydration } from "./helpers";
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

async function setPageVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((next) => {
    if (document.visibilityState === next) return;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

async function storedAt(page: Page, docId: string): Promise<string> {
  const response = await page.request.get(`/api/documents/${docId}`);
  expect(response.ok()).toBe(true);
  const body = await response.json() as { document: { updatedAt: string } };
  return body.document.updatedAt;
}

async function signInDemo(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await waitForHydration(page);
  await page.getByTestId("demo-signin").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForLoadState("networkidle");
  return { context, page };
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

test("a passive same-account tab reports a remote edit as saved", async ({ browser }) => {
  test.skip(Boolean(process.env.PROD_BASE_URL), "Requires the local demo account seeded by the E2E server");
  const account = await signInDemo(browser);
  const secondTab = await account.context.newPage();
  try {
    const welcome = account.page.getByTestId("document-card").filter({ hasText: "Welcome to Markdoc" });
    await expect(welcome).toHaveCount(1);
    const href = await welcome.getAttribute("href");
    if (!href?.startsWith("/d/")) throw new Error("Demo Welcome document link was not found");
    const docId = href.slice("/d/".length);
    await account.page.setViewportSize({ width: 780, height: 480 });
    await secondTab.setViewportSize({ width: 780, height: 480 });
    await Promise.all([openDocument(account.page, docId), openDocument(secondTab, docId)]);
    const before = await storedAt(account.page, docId);
    await focusCodeEnd(secondTab);
    await observePill(account.page);
    await secondTab.bringToFront();
    await setPageVisibility(account.page, "hidden");
    expect(await account.page.evaluate(() => document.visibilityState)).toBe("hidden");

    const remoteParagraph = "This paragraph was added from the other tab.";
    await secondTab.keyboard.press("Enter");
    await secondTab.keyboard.press("Enter");
    await secondTab.keyboard.insertText(remoteParagraph);
    await expect.poll(() => codeText(account.page)).toContain(remoteParagraph);
    await expect(secondTab.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    expect(await storedAt(account.page, docId)).not.toBe(before);
    await account.page.bringToFront();
    await setPageVisibility(account.page, "visible");
    await expect(account.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await expect(account.page.getByTestId("save-state")).toHaveAttribute("data-live-state", "saved");
    await expect(account.page.getByTestId("save-state")).toContainText("Saved");
    const states = (await pillChanges(account.page))
      .filter((change) => change.attr === "data-state")
      .map((change) => change.value);
    expect(states).toContain("pending");
    expect(states.at(-1)).toBe("saved");

    await account.page.locator(".cm-scroller").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await account.page.locator(".md-rich").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await account.page.screenshot({ path: "test-results/same-account-passive-tab-saved.png" });
    await secondTab.bringToFront();
    await secondTab.locator(".cm-scroller").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await secondTab.locator(".md-rich").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await secondTab.screenshot({ path: "test-results/same-account-active-tab-saved.png" });
  } finally {
    await account.context.close();
  }
});

interface ForcedStatus {
  state: string;
  label: string;
  unsynced?: number;
  prolonged?: boolean;
  saveError?: string;
}

/** Every label the header chip can show, shortest to longest. */
const STATUS_CASES: ForcedStatus[] = [
  { state: "saved", label: "Saved" },
  { state: "saving", label: "Saving…" },
  { state: "pending", label: "Unsaved changes" },
  { state: "connecting", label: "Connecting…" },
  { state: "reconnecting", label: "Reconnecting…" },
  { state: "error", label: "Not connected" },
  { state: "error", label: "Save failed — retry", saveError: "Store unavailable" },
  { state: "offline", label: "Offline — changes will sync" },
  { state: "offline", label: "Offline — 3 unsaved changes", unsynced: 3 },
  { state: "offline", label: "Offline — changes kept on this device", unsynced: 3, prolonged: true },
];

/** Puts the live session into one save state, so the real header renders it in the real layout. */
async function forceStatus(page: Page, forced: ForcedStatus) {
  await page.evaluate((f) => {
    const session = (window as unknown as { __markdocSession: Record<string, unknown> & { notify(): void } }).__markdocSession;
    const pin = (key: string, value: unknown) => Object.defineProperty(session, key, { configurable: true, get: () => value, set: () => {} });
    pin("saveState", f.state);
    pin("unsyncedChanges", f.unsynced ?? 0);
    pin("dirty", false);
    pin("recovered", false);
    pin("prolongedOffline", f.prolonged ?? false);
    pin("saveError", f.saveError ?? null);
    session.notify();
  }, forced);
  await expect(page.getByTestId("save-state")).toHaveText(forced.label);
}

/** Boxes of the save chip and of every other visible header control, measured in the laid-out page. */
async function measureHeader(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const header = document.querySelector('[data-testid="header"]')!;
    const chip = header.querySelector('[data-testid="save-state"]')!;
    const label = chip.querySelector("button > span") as HTMLElement;
    const labelShown = getComputedStyle(label).position !== "absolute";
    const text = document.createRange();
    text.selectNodeContents(label);
    const lines = new Set(Array.from(text.getClientRects(), (r) => Math.round(r.top)));
    const controls = Array.from(header.querySelectorAll('button, a, [data-testid="presence"]'))
      .filter((el) => !chip.contains(el) && el.checkVisibility({ visibilityProperty: true }))
      .map((el) => ({ name: el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.textContent ?? "", box: box(el) }));
    const root = document.scrollingElement!;
    // The tooltip a pointer resting on the label gets: the nearest `title` at or above whatever is hit there.
    const labelBox = label.getBoundingClientRect();
    const hit = labelShown ? document.elementFromPoint(labelBox.left + labelBox.width / 2, labelBox.top + labelBox.height / 2) : null;
    return {
      header: box(header),
      chip: box(chip),
      icon: box(chip.querySelector("svg")!),
      iconWidth: parseFloat(getComputedStyle(chip.querySelector("svg")!).width),
      titleWidth: header.querySelector('[data-testid="title-text"]')!.getBoundingClientRect().width,
      label: labelShown ? box(label) : null,
      labelLines: labelShown ? lines.size : 1,
      labelClipped: labelShown && label.scrollWidth > label.clientWidth,
      hitInChip: hit ? chip.contains(hit) : false,
      tooltip: hit?.closest("[title]")?.getAttribute("title") ?? null,
      controls,
      pageOverflow: root.scrollWidth - root.clientWidth,
    };
  });
}

test("the save chip never overlaps or spills into other header controls at any width", async ({ browser }) => {
  test.skip(Boolean(process.env.PROD_BASE_URL), "Requires the session hook that only non-production builds expose");
  const alice = await signIn(browser, "alice");
  try {
    const { page } = alice;
    const title = "A long document title that takes all the room the header can give it and then some more";
    const docId = await createDocument(page, CONTENT, title);
    await openDocument(page, docId);

    const widths = [390, 768, 820, 900, 1024, 1280, 1440];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      for (const status of STATUS_CASES) {
        const step = `${width}px "${status.label}"`;
        await forceStatus(page, status);
        const chipEl = page.getByTestId("save-state");
        await expect(chipEl, step).toHaveAttribute("role", "status");
        await expect(chipEl, step).toHaveAttribute("data-state", status.state);
        const m = await measureHeader(page);
        if (process.env.SHOT_DIR && ["Saved", "Saving…", "Save failed — retry", "Offline — changes will sync"].includes(status.label)) {
          const name = status.label.replace(/[^a-z]+/gi, "-").replace(/-$/, "").toLowerCase();
          await page.screenshot({ path: `${process.env.SHOT_DIR}/header-${width}-${name}.png`, clip: { x: 0, y: 0, width, height: 120 } });
        }
        // Soft: one run lists every width and state that is wrong.
        const parts = [{ name: "chip", box: m.chip }, { name: "icon", box: m.icon }, ...(m.label ? [{ name: "label", box: m.label }] : [])];
        for (const part of parts) {
          expect.soft(part.box.top, `${step}: ${part.name} top`).toBeGreaterThanOrEqual(m.header.top);
          expect.soft(part.box.bottom, `${step}: ${part.name} bottom`).toBeLessThanOrEqual(m.header.bottom);
          for (const control of m.controls) {
            const apart =
              part.box.right <= control.box.left + 0.5 ||
              part.box.left >= control.box.right - 0.5 ||
              part.box.bottom <= control.box.top + 0.5 ||
              part.box.top >= control.box.bottom - 0.5;
            expect.soft(apart, `${step}: ${part.name} ${JSON.stringify(part.box)} overlaps ${control.name} ${JSON.stringify(control.box)}`).toBe(true);
          }
        }
        expect.soft(m.labelLines, `${step}: label lines`).toBe(1);
        expect.soft(m.iconWidth, `${step}: icon width`).toBe(16);
        // From 1024 px the longest label still leaves the start of the title on screen.
        if (width >= 1024) expect.soft(m.titleWidth, `${step}: title width`).toBeGreaterThanOrEqual(40);
        expect.soft(m.pageOverflow, `${step}: page overflow`).toBeLessThanOrEqual(0);
        // A shortened label keeps its full text (or the error behind it) one hover away; a label that fits is shown whole.
        if (m.labelClipped) {
          expect.soft(m.hitInChip, `${step}: pointer on the label hits the chip`).toBe(true);
          expect.soft(m.tooltip, `${step}: tooltip`).toBe(status.saveError ?? status.label);
        }
        if (width >= 1440) expect.soft(m.labelClipped, `${step}: label shown whole`).toBe(false);
      }
    }

    // The chip's button and the mode menu still work from the keyboard at the narrowest desktop width.
    await page.setViewportSize({ width: 768, height: 800 });
    const save = page.getByRole("button", { name: "Save document", exact: true });
    await save.focus();
    await expect(save).toBeFocused();
    const mode = page.getByTestId("mode-switcher");
    await mode.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: /Editing/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(mode).toBeFocused();
  } finally {
    await alice.context.close();
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
