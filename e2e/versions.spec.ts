import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, focusCodeEnd } from "./helpers";

const V1 = "# Compare\n\nIntro stays the same in every version.\n\nFirst body line.\n\n\n\nClosing words stay put.\n\nAlpha paragraph carries distinct wording that is long enough to count.\n";
const V2 = "# Compare\n\nIntro stays the same in every version.\n\nAlpha paragraph carries distinct wording that is long enough to count.\n\nSecond body line.\n\n\n\nClosing words stay put.\n\nBrand new tail.\n";
// v3 moves the Alpha paragraph from the top to the bottom, nothing else changes.
const V3 = "# Compare\n\nIntro stays the same in every version.\n\nSecond body line.\n\n\n\nClosing words stay put.\n\nBrand new tail.\n\nAlpha paragraph carries distinct wording that is long enough to count.\n";

async function saveNamed(page: Page, id: string, content: string, message: string) {
  const res = await page.request.put(`/api/documents/${id}/content`, { data: { content, message } });
  expect(res.ok()).toBeTruthy();
}

async function openHistory(page: Page) {
  await page.getByTestId("more-menu").click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("version-item").filter({ hasText: title });

test.describe("name current version", () => {
  test("dialog opens with focus in the name field; typing + Enter names the version (#110)", async ({ browser }) => {
    const user = await signIn(browser, "vicky");
    const { page } = user;
    const id = await createDocument(page, "# Named\n\nSome words.\n");
    await openDocument(page, id);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

    // Opening from the ⋮ menu: the menu hands focus back to its trigger as it closes, which used to let
    // the dialog's own autofocus land on the header Close button — typing went nowhere and Enter dismissed.
    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Name current version" }).click();
    const dialog = page.getByRole("dialog", { name: "Name this version" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("version-name")).toBeFocused();
    await page.keyboard.type("v-scout");
    await expect(page.getByTestId("version-name")).toHaveValue("v-scout");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);

    await openHistory(page);
    await expect(row(page, "v-scout")).toBeVisible();
    await expect(row(page, "v-scout").getByTestId("version-kind")).toHaveText("Named");
    await user.context.close();
  });
});

test.describe("version compare", () => {
  test("compare two versions, swap, navigate hunks, moved paragraph, rename, copy as new document", async ({ browser }) => {
    const user = await signIn(browser, "vera");
    const { page } = user;
    const id = await createDocument(page, "# Compare\n");
    await saveNamed(page, id, V1, "One");
    await saveNamed(page, id, V2, "Two");
    await saveNamed(page, id, V3, "Three");
    await openDocument(page, id);
    await openHistory(page);

    await expect(row(page, "Three")).toBeVisible();
    await expect(row(page, "One").getByTestId("version-kind")).toHaveText("Named");

    // Tick v1 and v3 → old → new compare with both numbers in the header.
    const n1 = Number(await row(page, "One").getAttribute("data-version-number"));
    const n3 = Number(await row(page, "Three").getAttribute("data-version-number"));
    await row(page, "One").getByTestId("version-compare").check();
    await expect(page.getByTestId("compare-hint")).toContainText("one more");
    await row(page, "Three").getByTestId("version-compare").check();
    const diff = page.getByTestId("version-diff");
    await expect(diff).toBeVisible();
    await expect(page.getByTestId("diff-header")).toContainText(`v${n1} ‘One’ → v${n3} ‘Three’`);
    await expect(page.getByTestId("diff-header")).toContainText("vera");
    await expect(page.locator(".md-diff ins", { hasText: "Brand new tail." })).toBeVisible();
    await expect(page.locator(".md-diff del", { hasText: "First" })).toBeVisible();
    await expect(page.locator(".md-diff ins", { hasText: "Second" })).toBeVisible();
    // Authors of every version in the range are listed as chips.
    await expect(page.getByTestId("diff-authors")).toContainText(`v${n1 + 1}, v${n3}`);
    await expect(page.getByTestId("diff-author")).toHaveText(["vera"]);

    // Swap flips old and new: the insert becomes a delete.
    await page.getByTestId("diff-swap").click();
    await expect(page.getByTestId("diff-header")).toContainText(`v${n3} ‘Three’ → v${n1} ‘One’`);
    await expect(page.locator(".md-diff del", { hasText: "Brand new tail." })).toBeVisible();
    await expect(page.locator(".md-diff ins", { hasText: "First" })).toBeVisible();
    await page.getByTestId("diff-swap").click();

    // Hunk navigation: counter, `]` key and buttons, the active hunk is marked.
    const counter = page.getByTestId("diff-counter");
    await expect(counter).toHaveText(/^1 of \d+ changes$/);
    const total = Number((await counter.innerText()).match(/of (\d+)/)![1]);
    expect(total).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("diff-hunk-1")).toHaveAttribute("data-active", "true");
    await diff.focus();
    await page.keyboard.press("]");
    await expect(counter).toHaveText(`2 of ${total} changes`);
    await expect(page.getByTestId("diff-hunk-2")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("diff-hunk-1")).not.toHaveAttribute("data-active", "true");
    await page.keyboard.press("[");
    await expect(counter).toHaveText(`1 of ${total} changes`);
    await page.getByTestId("diff-next").click();
    await expect(counter).toHaveText(`2 of ${total} changes`);
    await page.getByTestId("diff-prev").click();
    await expect(counter).toHaveText(`1 of ${total} changes`);

    // v2 → v3 only moves the Alpha paragraph: one moved hunk, nothing red or green.
    await row(page, "One").getByTestId("version-compare").uncheck();
    await row(page, "Two").getByTestId("version-compare").check();
    await expect(page.getByTestId("diff-header")).toContainText(`‘Two’ → v${n3} ‘Three’`);
    await expect(counter).toHaveText("1 of 1 change");
    await expect(page.getByTestId("diff-moved")).toHaveCount(1);
    await expect(page.getByTestId("diff-moved")).toContainText("Alpha paragraph carries distinct wording");
    await expect(page.locator(".md-diff ins")).toHaveCount(0);
    await expect(page.locator(".md-diff del")).toHaveCount(0);
    await expect(page.getByTestId("diff-hunk-1").getByTestId("diff-moved")).toHaveCount(1);

    // Clearing the ticks returns to the editor.
    await page.getByTestId("compare-hint").getByText("Clear").click();
    await expect(diff).toBeHidden();

    // Type to produce an auto version (AUTO_VERSION_INTERVAL_MS is 1 s in e2e), then name it inline.
    await focusCodeEnd(page);
    await page.keyboard.type("\n\nTyped later.");
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    const autoRow = page.getByTestId("version-item").and(page.locator('[data-version-kind="auto"]')).first();
    await expect(autoRow).toBeVisible();
    const autoNumber = await autoRow.getAttribute("data-version-number");
    const auto = page.locator(`[data-testid="version-item"][data-version-number="${autoNumber}"]`);
    await expect(auto).toBeVisible();
    // #159: each fact once — the title says "Autosaved" (no chip, no number), the number is in the meta line only.
    const autoText = (await auto.textContent()) ?? "";
    expect(autoText.match(new RegExp(`v${autoNumber}(?!\\d)`, "g"))?.length).toBe(1);
    expect(autoText.match(/Auto/g)?.length).toBe(1);
    expect(autoText).toContain("Autosaved");
    await expect(auto.getByTestId("version-kind")).toHaveCount(0);
    // A named row: the name, one chip, one vN.
    const oneText = (await row(page, "One").textContent()) ?? "";
    expect(oneText.match(new RegExp(`v${n1}(?!\\d)`, "g"))?.length).toBe(1);
    await expect(row(page, "One").getByTestId("version-kind")).toHaveCount(1);
    await auto.getByRole("button").first().click();
    await expect(diff).toBeVisible();
    await auto.getByTestId("version-rename").click();
    await auto.getByTestId("version-rename-input").fill("Named by hand");
    await page.keyboard.press("Enter");
    await expect(row(page, "Named by hand")).toBeVisible();
    await expect(row(page, "Named by hand").getByTestId("version-kind")).toHaveText("Named");

    // Copy v1 as a new document: the new doc's text is exactly v1.
    await row(page, "One").getByRole("button").first().click();
    await expect(page.getByTestId("diff-header")).toContainText(`v${n1} ‘One’`);
    await row(page, "One").getByTestId("version-copy").click();
    await page.waitForURL((url) => url.pathname.startsWith("/d/") && !url.pathname.endsWith(id));
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.getByTestId("toast")).toContainText(`Copy of Compare (v${n1})`);
    await expect.poll(() => codeText(page)).toBe(V1);
    await user.context.close();
  });
});

