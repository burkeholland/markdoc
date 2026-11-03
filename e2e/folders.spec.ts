import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, uniqueLogin, waitForHydration, type User } from "./helpers";

/**
 * Folders on the dashboard (#2377): create, rename, delete, and the three ways a document is filed —
 * the card menu, a multi-select, and dragging a card onto a folder chip.
 *
 * What is here that the jsdom tests cannot reach: a real drag (jsdom has no `DataTransfer`, and the
 * unit test dispatches `dragstart` on the `<li>` while a browser fires it on the `<a>` inside the card,
 * which is natively draggable), real keyboard operation of the menu, and the fact that a move is still
 * there after a reload rather than only in the dashboard's local state.
 */

async function goHome(page: Page) {
  await page.goto("/");
  await waitForHydration(page);
  await expect(page.getByTestId("folder-rail")).toBeVisible();
}

const cardTitles = (page: Page) => page.getByTestId("document-card").getByRole("heading").allInnerTexts();

const chip = (page: Page, name: string) => page.getByTestId("folder-chip").filter({ hasText: name });

/** Create a folder through the rail's own dialog, and wait for its chip. */
async function newFolder(page: Page, name: string) {
  await page.getByTestId("new-folder").click();
  await page.getByTestId("folder-name-input").fill(name);
  await page.getByTestId("folder-name-submit").click();
  await expect(chip(page, name)).toBeVisible();
  // These specs exercise card actions after folder creation, so restore the all-documents view.
  await page.getByTestId("folder-all").click();
}

/** The card for a document, by its title. */
const card = (page: Page, title: string) => page.getByTestId("document-card").filter({ hasText: title });

/** The `<li>` wrapping a card, which is what carries the selection box, the ⋮ menu and `draggable`. */
const cardItem = (page: Page, title: string) => card(page, title).locator("..");

test.describe("folders", () => {
  let user: User;

  test.beforeEach(async ({ browser }) => {
    // A user per test: folders are per-owner, and the counts on the rail are the assertions here.
    user = await signIn(browser, uniqueLogin("folders"));
  });

  test.afterEach(async () => {
    await user.context.close();
  });

  test("creates a folder, files a document into it from the card menu, and keeps it there across a reload", async () => {
    const page = user.page;
    await createDocument(page, "# Soup\n\nStock first.\n", "Soup");
    await createDocument(page, "# Loose\n\nNot filed.\n", "Loose");
    await goHome(page);

    await newFolder(page, "Recipes");
    await expect(chip(page, "Recipes")).toContainText("0");
    await expect(page.getByTestId("folder-unfiled")).toContainText("2");

    await cardItem(page, "Soup").getByTestId("document-menu").click();
    await page.getByTestId("move-to-folder").click();

    await expect(chip(page, "Recipes")).toContainText("1");
    await expect(page.getByTestId("folder-unfiled")).toContainText("1");

    // Browsing the folder shows only what is in it.
    await chip(page, "Recipes").click();
    await expect.poll(() => cardTitles(page)).toEqual(["Soup"]);

    // The move is on the server, not only in the dashboard's local state.
    await page.reload();
    await waitForHydration(page);
    await expect(chip(page, "Recipes")).toContainText("1");
    await chip(page, "Recipes").click();
    await expect.poll(() => cardTitles(page)).toEqual(["Soup"]);
  });

  test("does not offer the folder a document is already in", async () => {
    const page = user.page;
    await createDocument(page, "# Soup\n", "Soup");
    await goHome(page);
    await newFolder(page, "Recipes");

    await cardItem(page, "Soup").getByTestId("document-menu").click();
    await page.getByTestId("move-to-folder").click();
    await expect(chip(page, "Recipes")).toContainText("1");

    await cardItem(page, "Soup").getByTestId("document-menu").click();
    // Already in Recipes, so that row is ticked off and only the top level is left to choose.
    await expect(page.getByTestId("move-to-folder")).toHaveAttribute("data-disabled", "");
    await expect(page.getByTestId("move-to-top-level")).not.toHaveAttribute("data-disabled", "");
  });

  test("opens the move menu and files a document with the keyboard alone", async () => {
    const page = user.page;
    await createDocument(page, "# Keyboard\n", "Keyboard");
    await goHome(page);
    await newFolder(page, "Filed");

    // The issue asks for the menu to work from the keyboard, so no click is used past this point.
    await cardItem(page, "Keyboard").getByTestId("document-menu").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();

    // The top-level row is disabled because the document is already at the top level, so focus starts
    // on the first enabled folder row.
    await expect(page.getByTestId("move-to-folder")).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(chip(page, "Filed")).toContainText("1");
    // The closed menu must leave nothing behind: an invisible Radix leftover used to swallow clicks.
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("moves several selected documents at once", async () => {
    const page = user.page;
    await createDocument(page, "# One\n", "One");
    await createDocument(page, "# Two\n", "Two");
    await createDocument(page, "# Three\n", "Three");
    await goHome(page);
    await newFolder(page, "Batch");

    await cardItem(page, "One").getByTestId("select-document").check();
    await cardItem(page, "Two").getByTestId("select-document").check();
    await expect(page.getByTestId("selection-bar")).toContainText("2 documents selected");

    await page.getByTestId("selection-move").click();
    await page.getByTestId("move-to-folder").click();

    await expect(chip(page, "Batch")).toContainText("2");
    await expect(page.getByTestId("selection-bar")).toHaveCount(0);

    await chip(page, "Batch").click();
    await expect.poll(async () => (await cardTitles(page)).sort()).toEqual(["One", "Two"]);
  });

  test("drags a card onto a folder chip, and back out onto 'Not in a folder'", async () => {
    const page = user.page;
    await createDocument(page, "# Dragged\n", "Dragged");
    await goHome(page);
    await newFolder(page, "Target");

    // A real mouse drag. The card's inner <a> is natively draggable, so the browser makes the link the
    // drag source and the dragstart reaches the <li> handler by bubbling — the part jsdom cannot show.
    await cardItem(page, "Dragged").dragTo(chip(page, "Target"));
    await expect(chip(page, "Target")).toContainText("1");

    await chip(page, "Target").click();
    await expect.poll(() => cardTitles(page)).toEqual(["Dragged"]);

    await cardItem(page, "Dragged").dragTo(page.getByTestId("folder-unfiled"));
    await expect(chip(page, "Target")).toContainText("0");
    await page.getByTestId("folder-unfiled").click();
    await expect.poll(() => cardTitles(page)).toEqual(["Dragged"]);
  });

  test("dragging a selected card takes the whole selection", async () => {
    const page = user.page;
    await createDocument(page, "# First\n", "First");
    await createDocument(page, "# Second\n", "Second");
    await goHome(page);
    await newFolder(page, "Both");

    await cardItem(page, "First").getByTestId("select-document").check();
    await cardItem(page, "Second").getByTestId("select-document").check();
    await cardItem(page, "First").dragTo(chip(page, "Both"));

    await expect(chip(page, "Both")).toContainText("2");
  });

  test("renames a folder, and refuses a name already in use", async () => {
    const page = user.page;
    await goHome(page);
    await newFolder(page, "Taken");
    await newFolder(page, "Old name");

    const menuFor = (name: string) =>
      page.getByTestId("folder-chip").filter({ hasText: name }).locator("..").getByTestId("folder-menu");

    await menuFor("Old name").click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await page.getByTestId("folder-name-input").fill("New name");
    await page.getByTestId("folder-name-submit").click();
    await expect(chip(page, "New name")).toBeVisible();
    await expect(chip(page, "Old name")).toHaveCount(0);

    // The unique index is case-insensitive, so "taken" collides with "Taken".
    await menuFor("New name").click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await page.getByTestId("folder-name-input").fill("taken");
    await page.getByTestId("folder-name-submit").click();
    await expect(page.getByTestId("toast")).toContainText("already have a folder with that name");
    await expect(chip(page, "New name")).toBeVisible();
  });

  test("deleting a folder says what happens to its documents and sends them to the trash", async () => {
    const page = user.page;
    await createDocument(page, "# Doomed\n", "Doomed");
    await goHome(page);
    await newFolder(page, "Going away");

    await cardItem(page, "Doomed").getByTestId("document-menu").click();
    await page.getByTestId("move-to-folder").click();
    await expect(chip(page, "Going away")).toContainText("1");

    await page.getByTestId("folder-chip").locator("..").getByTestId("folder-menu").click();
    await page.getByRole("menuitem", { name: "Delete folder…" }).click();
    await expect(page.getByText(/1 document goes to the trash/)).toBeVisible();
    await page.getByTestId("delete-folder-submit").click();

    await expect(page.getByTestId("folder-chip")).toHaveCount(0);
    // Not destroyed: the document is in the trash, where it can be restored.
    await page.getByTestId("filter-trash").click();
    await expect(page.getByTestId("trash-card").filter({ hasText: "Doomed" })).toBeVisible();
  });

  test("removing a pending folder invite clears its message when the dialog is reopened", async () => {
    const page = user.page;
    const login = uniqueLogin("no-such-user");
    const folderName = "Pending invite";
    const note = `@${login} gets access on their first sign-in. Check the spelling.`;
    await goHome(page);
    await newFolder(page, folderName);

    await page.getByTestId("folder-menu").click();
    await page.getByRole("menuitem", { name: "Share…" }).click();
    const dialog = page.getByTestId("folder-share-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("share-login").fill(login);
    await dialog.getByTestId("folder-share-add").click();
    await expect(dialog.getByText(note)).toBeVisible();
    await dialog.getByRole("button", { name: `Remove ${login}` }).click();
    await expect(dialog.getByText(note)).toHaveCount(0);
    await expect(dialog.getByText("No one else has access yet.")).toBeVisible();

    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByTestId("folder-menu").click();
    await page.getByRole("menuitem", { name: "Share…" }).click();
    await expect(dialog.getByText(note)).toHaveCount(0);
    await expect(dialog.getByText("No one else has access yet.")).toBeVisible();
    if (process.env.SHOT_DIR) await page.getByRole("dialog").screenshot({ path: `${process.env.SHOT_DIR}/folder-share-after-removal.png` });
  });

  test("shares a folder role with every current and future document", async ({ browser }) => {
    const page = user.page;
    const recipient = await signIn(browser, uniqueLogin("folder-recipient"));
    try {
      const currentIds = [
        await createDocument(page, "# Folder note\n", "Folder note"),
        await createDocument(page, "# Second note\n", "Second note"),
      ];
      await goHome(page);
      await newFolder(page, "Project files");
      const folderId = await chip(page, "Project files").getAttribute("data-folder-id");
      if (!folderId) throw new Error("folder chip has no folder id");

      for (const title of ["Folder note", "Second note"]) {
        await cardItem(page, title).getByTestId("document-menu").click();
        await page.getByTestId("move-to-folder").click();
      }

      await page.getByTestId("folder-menu").click();
      await page.getByRole("menuitem", { name: "Share…" }).click();
      const dialog = page.getByTestId("folder-share-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("share-login").fill(recipient.login);
      await dialog.getByLabel("Role for new folder collaborator").selectOption("commenter");
      await dialog.getByTestId("folder-share-add").click();
      await expect(dialog.getByText(`@${recipient.login}`)).toBeVisible();
      await expect(dialog.getByLabel(`Role for ${recipient.login}`)).toHaveValue("commenter");
      if (process.env.SHOT_DIR) await page.getByRole("dialog").screenshot({ path: `${process.env.SHOT_DIR}/folder-sharing-dialog.png` });

      const futureId = await createDocument(page, "# Added later\n", "Added later");
      const moved = await page.request.post("/api/documents/move", { data: { documentIds: [futureId], folderId } });
      expect(moved.ok()).toBeTruthy();
      expect(await moved.json()).toMatchObject({ moved: [futureId] });

      await goHome(recipient.page);
      const sharedFolder = recipient.page.getByTestId("shared-folder-chip").filter({ hasText: "Project files" });
      await expect(sharedFolder).toContainText("3");
      await sharedFolder.click();
      await expect(card(recipient.page, "Folder note")).toBeVisible();
      await expect(card(recipient.page, "Second note")).toBeVisible();
      await expect(card(recipient.page, "Added later")).toBeVisible();

      for (const id of [...currentIds, futureId]) {
        const access = await recipient.page.request.get(`/api/documents/${id}`);
        expect(access.ok()).toBeTruthy();
        expect(await access.json()).toMatchObject({ role: "commenter" });
      }
      if (process.env.SHOT_DIR) await recipient.page.screenshot({ path: `${process.env.SHOT_DIR}/folder-shared-with-me.png` });
    } finally {
      await recipient.context.close();
    }
  });

  test("offers no folder controls on a document owned by someone else", async ({ browser }) => {
    const page = user.page;
    const owner = await signIn(browser, uniqueLogin("owner"));
    try {
      const id = await createDocument(owner.page, "# Theirs\n", "Theirs");
      const res = await owner.page.request.post(`/api/documents/${id}/collaborators`, {
        data: { login: user.login, role: "editor" },
      });
      expect(res.ok()).toBeTruthy();

      await goHome(page);
      const shared = cardItem(page, "Theirs");
      await expect(shared).toBeVisible();
      // A folder belongs to one person, so there is nowhere for a collaborator to file this.
      await expect(shared.getByTestId("document-menu")).toHaveCount(0);
      await expect(shared.getByTestId("select-document")).toHaveCount(0);
      await expect(shared).not.toHaveAttribute("draggable", "true");
    } finally {
      await owner.context.close();
    }
  });
});
