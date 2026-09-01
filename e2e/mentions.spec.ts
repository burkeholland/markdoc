import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, shareWith, selectTextInRich, waitForHydration, uniqueLogin, type User } from "./helpers";

test.describe("@mentions in comments", () => {
  let alice: User;
  let bob: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    // Both per run (computed once, here): Bob's notifications strip is counted account-wide below, and a fixed
    // `bob` still carries the previous run's mention (--repeat-each, a CI retry) and other specs' shares.
    alice = await signIn(browser, uniqueLogin("alice"));
    bob = await signIn(browser, uniqueLogin("bob"));
    docId = await createDocument(alice.page, "# Mentions doc\n\nFirst paragraph.\n", "Mentions doc");
    await shareWith(alice.page, docId, bob.login, "editor");
    await openDocument(alice.page, docId);
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close();
  });

  test("typing @ suggests collaborators, inserts a mention and renders it as a chip", async () => {
    await selectTextInRich(alice.page, "First paragraph");
    await alice.page.getByTestId("tb-comment").click();
    const composer = alice.page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await alice.page.keyboard.type("hi @");

    const suggestions = alice.page.getByTestId("mention-suggestions");
    await expect(suggestions).toBeVisible();
    // Bob is a collaborator (not present), Alice herself is not offered.
    await expect(suggestions.getByTestId("mention-option")).toHaveCount(1);
    await expect(suggestions.getByTestId("mention-option").first()).toHaveAttribute("data-login", bob.login);
    await alice.page.keyboard.press("Enter");
    await expect(suggestions).toHaveCount(0);
    await expect(composer).toHaveValue(`hi @${bob.login} `);
    await expect(composer).toBeFocused();

    await alice.page.keyboard.type("can you check this?");
    await alice.page.getByTestId("comment-submit").click();
    const thread = alice.page.getByTestId("comment-thread");
    await expect(thread).toHaveCount(1);
    const chip = thread.getByTestId("mention-chip");
    await expect(chip).toHaveText(`@${bob.login}`);
    await expect(chip).toHaveAttribute("title", bob.login);
    await expect(thread).toContainText(`hi @${bob.login} can you check this?`);

    // The body stays plain text; the mentions are parsed once and exposed to agents.
    const res = await alice.page.request.get(`/api/documents/${docId}/comments`);
    const { comments } = (await res.json()) as { comments: { body: string; mentions: string[] }[] };
    expect(comments[0].body).toBe(`hi @${bob.login} can you check this?`);
    expect(comments[0].mentions).toEqual([bob.login]);
  });

  test("the mentioned user sees the mention on the dashboard and clicking it marks it read", async () => {
    await expect
      .poll(async () => {
        const res = await bob.page.request.get("/api/mentions");
        const { mentions } = (await res.json()) as { mentions: { documentId: string; documentTitle: string }[] };
        return mentions.filter((m) => m.documentId === docId).map((m) => m.documentTitle);
      })
      .toEqual(["Mentions doc"]);

    await bob.page.goto("/");
    await waitForHydration(bob.page);
    const strip = bob.page.getByTestId("notifications-strip");
    await expect(strip).toBeVisible();
    // The strip carries every kind (Bob was also notified of the share); look at the mention.
    const item = strip.locator("[data-testid=notification-item][data-kind=mention]");
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("notification-doc-title")).toHaveText("Mentions doc");
    await expect(item).toContainText(`${alice.login} mentioned you`);
    await expect(item).toContainText(`hi @${bob.login} can you check this?`);

    await item.getByTestId("notification-open").click();
    await bob.page.waitForURL(`**/d/${docId}**`);
    await expect
      .poll(async () => {
        const res = await bob.page.request.get("/api/mentions");
        return ((await res.json()) as { mentions: { documentId: string }[] }).mentions.filter((m) => m.documentId === docId).length;
      })
      .toBe(0);

    await bob.page.goto("/");
    await bob.page.waitForLoadState("networkidle");
    await expect(bob.page.locator("[data-testid=notification-item][data-kind=mention]")).toHaveCount(0);
  });

  test("mentions written through the comments API are recorded too and e-mails are not", async () => {
    const body = `@${bob.login} ping, and not mail@bob.example`;
    const res = await alice.page.request.post(`/api/documents/${docId}/comments`, {
      data: { action: "add", quote: "Mentions doc", body },
    });
    expect(res.ok()).toBeTruthy();
    await expect
      .poll(async () => {
        const r = await bob.page.request.get("/api/mentions");
        return ((await r.json()) as { mentions: { documentId: string; snippet: string }[] }).mentions.filter((m) => m.documentId === docId).map((m) => m.snippet);
      })
      .toEqual([body]);
    // Nobody called "bob.example" was mentioned: alice (the author) has no mention in this document.
    // Per document, not "alice has none anywhere": other specs mention `@alice/<agent>` on the same server.
    const alicesMentions = await alice.page.request.get("/api/mentions");
    const { mentions } = (await alicesMentions.json()) as { mentions: { documentId: string }[] };
    expect(mentions.filter((m) => m.documentId === docId)).toEqual([]);
  });
});
