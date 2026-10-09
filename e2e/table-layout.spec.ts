import { test, expect } from "./fixtures";
import { clickCell, createDocument, mintToken, openDocument, signIn, tableCell, tableLines, uniqueLogin } from "./helpers";

const TABLE = "| Name | Owner | Status |\n| --- | --- | --- |\n| Alpha | Ann | Open |\n| Beta | Bob | Open |\n| Gamma | Cy | Blocked |";

/** What each row of the rich pane's table holds, by tag: a caret or any other element among the cells shows up here. */
const rowChildren = (page: import("@playwright/test").Page) =>
  page.locator(".md-rich table tr").evaluateAll((rows) => rows.map((row) => Array.from(row.children, (child) => child.tagName).join(" ")));

const cellTexts = (page: import("@playwright/test").Page, row: number) =>
  page.locator(".md-rich table tr").nth(row).locator("td,th").evaluateAll((cells) => cells.map((cell) => cell.textContent));

test("an agent's rewrite of a table row is a new row above the old one, in the same columns", async ({ browser }) => {
  const user = await signIn(browser, uniqueLogin("table-suggest"));
  const page = user.page;
  const minted = await mintToken(page, "Table agent");
  try {
    const docId = await createDocument(page, `# Plan\n\n${TABLE}\n\nAfter.\n`, "Table suggestions");
    await openDocument(page, docId);
    await expect.poll(() => rowChildren(page)).toEqual(["TH TH TH", "TD TD TD", "TD TD TD", "TD TD TD"]);

    const proposal = await page.request.post(`/api/documents/${docId}/suggest`, {
      headers: { Authorization: ["Bearer", minted.token].join(" ") },
      data: { edits: [{ find: "| Beta | Bob | Open |", replace: "| Beta program | Robert | Closed last week |" }] },
    });
    expect(proposal.status()).toBe(200);
    expect(((await proposal.json()) as { suggestions: number }).suggestions).toBe(1);

    // Three cells in every row and nothing else: no column added, and the agent's caret is inside a cell.
    await expect.poll(() => rowChildren(page)).toEqual(["TH TH TH", "TD TD TD", "TD TD TD", "TD TD TD", "TD TD TD"]);
    await expect(page.locator(".md-rich .md-remote-caret")).toHaveCount(1);
    await expect(page.locator(".md-rich :is(td, th) .md-remote-caret")).toHaveCount(1);
    expect(await cellTexts(page, 2)).toEqual(["Beta program", "Robert", "Closed last week"]);
    await expect(page.locator(".md-rich table tr").nth(2).locator(".md-suggest-insert")).toHaveText(["Beta program", "Robert", "Closed last week"]);
    await expect(page.locator(".md-rich table tr").nth(3).locator(".md-suggest-delete")).toHaveText(["Beta", "Bob", "Open"]);
    await expect(page.locator(".md-rich table .md-suggest-insert, .md-rich table .md-suggest-delete")).toHaveCount(6);

    // Typing in another cell writes the whole table again with its columns lined up. That is padding,
    // not a change to the suggested rows: the suggestion can still be decided.
    await clickCell(page, 1, 0);
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect.poll(async () => (await tableLines(page))[2]).toBe("| Alpha!       | Ann    | Open             |");
    await expect.poll(() => rowChildren(page)).toEqual(["TH TH TH", "TD TD TD", "TD TD TD", "TD TD TD", "TD TD TD"]);

    const currentText = async () => ((await (await page.request.get(`/api/documents/${docId}/content`)).json()) as { content: string }).content;
    await expect.poll(currentText).toContain("| Alpha!       |");
    const decided = await page.request.post(`/api/documents/${docId}/suggestions`, { data: { action: "acceptAll" } });
    expect(decided.status()).toBe(200);
    expect(((await decided.json()) as { decided: number }).decided).toBe(1);
    await expect.poll(() => rowChildren(page)).toEqual(["TH TH TH", "TD TD TD", "TD TD TD", "TD TD TD"]);
    expect(await cellTexts(page, 2)).toEqual(["Beta program", "Robert", "Closed last week"]);
    await expect.poll(currentText).toBe(
      [
        "# Plan",
        "",
        "| Name         | Owner  | Status           |",
        "| ------------ | ------ | ---------------- |",
        "| Alpha!       | Ann    | Open             |",
        "| Beta program | Robert | Closed last week |",
        "| Gamma        | Cy     | Blocked          |",
        "",
        "After.",
        "",
      ].join("\n"),
    );
  } finally {
    await minted.revoke();
  }
});

test("a row with more cells than the header does not add columns to the table", async ({ browser }) => {
  const user = await signIn(browser, uniqueLogin("table-ragged"));
  const page = user.page;
  const docId = await createDocument(page, "| a | b |\n| --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |\n", "Ragged table");
  await openDocument(page, docId);
  await expect.poll(() => rowChildren(page)).toEqual(["TH TH", "TD TD", "TD TD"]);
  expect(await cellTexts(page, 1)).toEqual(["1", "2"]);
});

test("a click beside a table that starts the document does not move the table", async ({ browser }) => {
  const user = await signIn(browser, uniqueLogin("table-gap"));
  const page = user.page;
  const docId = await createDocument(page, `${TABLE}\n`, "Table first");
  await openDocument(page, docId);
  const table = page.locator(".md-rich table");
  const gapCursor = page.locator(".md-rich .ProseMirror-gapcursor");
  await clickCell(page, 1, 0);
  const before = (await table.boundingBox())!;

  // The pane's own padding, left of the table: the caret this gives is the gap cursor before the table.
  await page.mouse.click(before.x - 10, before.y + before.height / 2);
  await expect(gapCursor).toHaveCount(1);
  expect(await gapCursor.evaluate((element) => getComputedStyle(element).position)).toBe("absolute");
  expect(await table.boundingBox()).toEqual(before);

  await clickCell(page, 2, 1);
  await expect(gapCursor).toHaveCount(0);
  expect(await table.boundingBox()).toEqual(before);
});

test("a space typed at the end of a table cell is there when the next word is typed", async ({ browser }) => {
  const user = await signIn(browser, uniqueLogin("table-space"));
  const page = user.page;
  const docId = await createDocument(page, `${TABLE}\n`, "Table typing");
  await openDocument(page, docId);
  await clickCell(page, 2, 0);
  await page.keyboard.press("End");
  // One key at a time, as a person types: the space is the last character of the cell until "a" arrives.
  await page.keyboard.press("Space");
  await expect.poll(() => tableCell(page, 2, 0).evaluate((cell) => cell.textContent)).toBe("Beta ");
  await page.keyboard.type("and more", { delay: 60 });
  await expect.poll(() => tableCell(page, 2, 0).evaluate((cell) => cell.textContent)).toBe("Beta and more");
  await expect.poll(async () => (await tableLines(page))[3]).toBe("| Beta and more | Bob   | Open    |");
});
