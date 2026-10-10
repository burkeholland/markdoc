import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, selectTextInRich, uniqueLogin, type User } from "./helpers";

/**
 * Managed accounts (Enterprise Managed Users, the work accounts a company's identity provider creates):
 * GitHub names them `handle_shortcode`. The underscore has to survive everywhere a handle is typed or
 * read: the Share dialog, the access that share gives, and an `@` mention. All input is real.
 *
 * The sign-in itself (GitHub's side faked) is covered by src/auth.test.ts.
 */
test.describe("a managed account's handle (handle_shortcode)", () => {
  let owner: User;
  let mona: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    owner = await signIn(browser, uniqueLogin("owner"));
    mona = await signIn(browser, `${uniqueLogin("mona")}_octo`);
    docId = await createDocument(owner.page, "# Managed accounts\n\nFirst paragraph.\n", "Managed accounts");
  });

  test.afterAll(async () => {
    await owner.context.close();
    await mona.context.close();
  });

  test("the owner shares by the typed handle and the managed account opens the document", async () => {
    await openDocument(owner.page, docId);
    await owner.page.getByTestId("share-button").click();
    const input = owner.page.getByTestId("share-login");
    await expect(input).toBeFocused();
    await expect(owner.page.getByTestId("collaborator-list-loading")).toHaveCount(0);

    await owner.page.keyboard.type(`@${mona.login}`);
    await expect(owner.page.getByTestId("share-add")).toBeEnabled();
    await owner.page.getByTestId("share-add").click();

    await expect(owner.page.getByTestId("share-add-error")).toHaveCount(0);
    await expect(owner.page.getByTestId("collaborator-row").filter({ hasText: mona.login })).toHaveCount(1);
    const { collaborators } = (await (await owner.page.request.get(`/api/documents/${docId}/collaborators`)).json()) as { collaborators: { login: string; role: string }[] };
    expect(collaborators).toEqual([expect.objectContaining({ login: mona.login, role: "editor" })]);

    await openDocument(mona.page, docId);
    await expect(mona.page).toHaveURL(new RegExp(`/d/${docId}`));
  });

  test("a mention of the managed account is the whole handle and reaches that account", async () => {
    // A fresh page: the Share dialog of the test above is gone and the picker has the new collaborator.
    await openDocument(owner.page, docId);
    await selectTextInRich(owner.page, "First paragraph");
    await owner.page.getByTestId("tb-comment").click();
    const composer = owner.page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    // Typed through the underscore: the suggestion stays while the short code is being typed.
    await owner.page.keyboard.type(`hi @${mona.login.slice(0, mona.login.indexOf("_") + 2)}`);
    const option = owner.page.getByTestId("mention-suggestions").getByTestId("mention-option");
    await expect(option).toHaveCount(1);
    await expect(option).toHaveAttribute("data-login", mona.login);
    await owner.page.keyboard.press("Enter");
    await expect(composer).toHaveValue(`hi @${mona.login} `);

    await owner.page.keyboard.type("can you check this?");
    await owner.page.getByTestId("comment-submit").click();
    const chip = owner.page.getByTestId("comment-thread").getByTestId("mention-chip");
    await expect(chip).toHaveText(`@${mona.login}`);

    const { comments } = (await (await owner.page.request.get(`/api/documents/${docId}/comments`)).json()) as { comments: { mentions: string[] }[] };
    expect(comments[0].mentions).toEqual([mona.login]);
    await expect
      .poll(async () => {
        const { mentions } = (await (await mona.page.request.get("/api/mentions")).json()) as { mentions: { documentId: string }[] };
        return mentions.filter((mention) => mention.documentId === docId).length;
      })
      .toBe(1);
  });
});
