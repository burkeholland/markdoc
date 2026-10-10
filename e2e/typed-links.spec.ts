import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { codeText, createDocument, openDocument, shareWith, signIn } from "./helpers";

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function typeAddress(page: Page, target: Locator) {
  await target.click();
  await page.keyboard.press("End");
  await page.keyboard.type(` ${URL}`, { delay: 100 });
}

async function pasteText(page: Page, text: string) {
  await page.evaluate((value) => {
    const root = document.querySelector(".ProseMirror");
    if (!root) throw new Error(".ProseMirror not found");
    const data = new DataTransfer();
    data.setData("text/plain", value);
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function expectWholeLink(target: Locator) {
  const links = target.locator("a");
  await expect(links).toHaveCount(1);
  await expect(links).toHaveText(URL);
  await expect(links).toHaveAttribute("href", URL);
}

async function expectPlainOrWholeLink(target: Locator) {
  const links = target.locator("a");
  const count = await links.count();
  expect(count).toBeLessThanOrEqual(1);
  if (count === 1) {
    await expect(links).toHaveText(URL);
    await expect(links).toHaveAttribute("href", URL);
  }
}

test.describe("typed web addresses (#2353)", () => {
  test("human-speed typing stays whole in paragraphs, lists, quotes, tables, and headings", async ({ browser }) => {
    const alice = await signIn(browser, "typed-links-alice");
    const bob = await signIn(browser, "typed-links-bob");
    const source = [
      "Paragraph",
      "",
      "- List",
      "",
      "> Quote",
      "",
      "## Heading",
      "",
      "| Column |",
      "| --- |",
      "| Cell |",
      "",
    ].join("\n");
    const id = await createDocument(alice.page, source);
    await shareWith(alice.page, id, "typed-links-bob", "editor");
    await openDocument(alice.page, id);
    await openDocument(bob.page, id);

    const contexts = [
      { line: `Paragraph ${URL}`, alice: alice.page.locator(".md-rich > p").first(), bob: bob.page.locator(".md-rich > p").first(), linked: false },
      { line: `- List ${URL}`, alice: alice.page.locator(".md-rich li p").first(), bob: bob.page.locator(".md-rich li p").first(), linked: true },
      { line: `> Quote ${URL}`, alice: alice.page.locator(".md-rich blockquote p").first(), bob: bob.page.locator(".md-rich blockquote p").first(), linked: true },
      { line: `## Heading ${URL}`, alice: alice.page.locator(".md-rich h2").first(), bob: bob.page.locator(".md-rich h2").first(), linked: true },
      { line: `Cell ${URL}`, alice: alice.page.locator(".md-rich td").first(), bob: bob.page.locator(".md-rich td").first(), linked: true },
    ];

    for (const context of contexts) {
      await typeAddress(alice.page, context.alice);
      await expect.poll(() => codeText(alice.page)).toContain(context.line);
      await expect.poll(() => codeText(bob.page)).toContain(context.line);
      if (context.linked) {
        await expectWholeLink(context.alice);
        await expectWholeLink(context.bob);
      } else {
        await expectPlainOrWholeLink(context.alice);
        await expectPlainOrWholeLink(context.bob);
      }
    }

    const beforeReload = await codeText(alice.page);
    expect(beforeReload).not.toContain("<https://w>");
    expect(beforeReload).not.toContain("[www](http://www)");

    await openDocument(alice.page, id);
    await expect.poll(() => codeText(alice.page)).toBe(beforeReload);
    await expectWholeLink(alice.page.locator(".md-rich li p").first());
    await expectWholeLink(alice.page.locator(".md-rich blockquote p").first());
    await expectWholeLink(alice.page.locator(".md-rich h2").first());
    await expectWholeLink(alice.page.locator(".md-rich td").first());

    await alice.context.close();
    await bob.context.close();
  });

  test("typed and pasted addresses keep the same Markdown and undo/redo boundary", async ({ browser }) => {
    const user = await signIn(browser, "typed-links-roundtrip");
    const id = await createDocument(user.page, "- Typed\n- Pasted\n");
    await openDocument(user.page, id);
    const { page } = user;
    const items = page.locator(".md-rich li p");

    await typeAddress(page, items.nth(0));
    await items.nth(1).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await pasteText(page, URL);

    await expect.poll(() => codeText(page)).toContain(`- Typed ${URL}\n- Pasted ${URL}`);
    await expectWholeLink(items.nth(0));
    await expectWholeLink(items.nth(1));
    const typedLine = (await codeText(page)).split("\n")[0].replace("Typed", "Pasted");
    expect(typedLine).toBe((await codeText(page)).split("\n")[1]);

    await page.getByTestId("tb-undo").click();
    await expect.poll(async () => (await codeText(page)).trimEnd()).toBe("- Typed\n- Pasted");
    await page.getByTestId("tb-redo").click();
    await expect.poll(async () => (await codeText(page)).trimEnd()).toBe(`- Typed ${URL}\n- Pasted ${URL}`);
    await expectWholeLink(items.nth(0));
    await expectWholeLink(items.nth(1));

    await user.context.close();
  });

  test("typing beside intentional angle web and mail links preserves their syntax", async ({ browser }) => {
    const alice = await signIn(browser, "typed-links-angle-alice");
    const bob = await signIn(browser, "typed-links-angle-bob");
    const source = "- Web <https://example.com>\n- Mail <mailto:person@example.com>\n";
    const expected = "- Web <https://example.com>x\n- Mail <mailto:person@example.com>x\n";
    const id = await createDocument(alice.page, source);
    await shareWith(alice.page, id, "typed-links-angle-bob", "editor");
    await openDocument(alice.page, id);
    await openDocument(bob.page, id);

    const aliceItems = alice.page.locator(".md-rich li p");
    for (const item of [aliceItems.nth(0), aliceItems.nth(1)]) {
      await item.click();
      await alice.page.keyboard.press("End");
      await alice.page.keyboard.type("x");
    }

    await expect.poll(() => codeText(alice.page)).toBe(expected);
    await expect.poll(() => codeText(bob.page)).toBe(expected);
    for (const page of [alice.page, bob.page]) {
      const links = page.locator(".md-rich li p a");
      await expect(links.nth(0)).toHaveText("https://example.com");
      await expect(links.nth(0)).toHaveAttribute("href", "https://example.com");
      await expect(links.nth(1)).toHaveText("mailto:person@example.com");
      await expect(links.nth(1)).toHaveAttribute("href", "mailto:person@example.com");
    }

    await openDocument(alice.page, id);
    await expect.poll(() => codeText(alice.page)).toBe(expected);

    await alice.context.close();
    await bob.context.close();
  });
});
