import { test, expect } from "./fixtures";
import { createDocument, signIn } from "./helpers";

// #2415: at 375 px the header title collapsed to "Long …".
test("the phone header shows the whole short title and at least 12 characters of a long one", async ({ browser }) => {
  const user = await signIn(browser, "phone-title");
  const { page } = user;
  await page.setViewportSize({ width: 375, height: 812 });
  for (const [title, whole] of [
    ["Long document", true],
    ["Quarterly planning notes for the platform team", false],
  ] as const) {
    const id = await createDocument(page, `# ${title}\n\nText.`, title);
    await page.goto(`/d/${id}`);
    await page.getByTestId("save-state").waitFor();
    await page.waitForTimeout(500);
    const text = page.getByTestId("title-text");
    await expect(text).toHaveText(title);
    const shown = await text.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const box = element.getBoundingClientRect();
      // Count characters whose glyph box lies inside the clamped title box.
      let visible = 0;
      const node = element.firstChild!;
      for (let index = 0; index < (node.textContent ?? "").length; index++) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.bottom <= box.bottom + 0.5 && rect.right <= box.right + 0.5) visible++;
      }
      return { visible, clipped: element.scrollHeight > element.clientHeight + 1 };
    });
    if (whole) expect(shown.clipped, `"${title}" is not clipped`).toBe(false);
    expect(shown.visible).toBeGreaterThanOrEqual(12);
    const header = (await page.getByTestId("header").boundingBox())!;
    const box = (await text.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(header.y);
    expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
  }
  await user.context.close();
});
