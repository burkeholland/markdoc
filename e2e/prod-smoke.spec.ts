import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { createDocument, devLogin, ensureCommentsOpen, expectCommentsTab, expectThemeOption, mintToken, openDocument, openPhoneComments, richText, uniqueLogin, waitForHydration } from "./helpers";

/** Text of the code pane as rendered. The dev-only `__markdocSession` hook used by the regular suite is not exposed by a production build. */
const codeText = (page: Page) => page.locator(".cm-content").innerText();

/**
 * Browser smoke for a production build that is already running (see `npm run start:local`).
 *
 *   PROD_BASE_URL=http://localhost:3900 npx playwright test e2e/prod-smoke.spec.ts
 *
 * Skipped when PROD_BASE_URL is unset so the regular suite (which starts its own dev server on
 * :3100) is unaffected. The production server must have AUTH_DEV_LOGIN=force for the dev login.
 */
const base = process.env.PROD_BASE_URL?.replace(/\/$/, "");

test.describe("production build", () => {
  test.skip(!base, "PROD_BASE_URL not set");
  test.use({ baseURL: base ?? "http://localhost:3900" });

  test("dashboard, template document, typing in both panes over the collaboration socket", async ({ page }) => {
    const login = `prod-smoke-${Date.now().toString(36)}`;

    // Health says the collaboration server is attached to this process.
    const health = await page.request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, db: true, collab: true });

    // Development login (allowed in production only with AUTH_DEV_LOGIN=force). The build under test comes
    // from this checkout, so it carries the html[data-hydrated] marker devLogin waits for.
    await devLogin(page, login);
    await page.waitForLoadState("networkidle");

    // The API limiter is on in production: every /api/* response says how much budget is left.
    const me = await page.request.get("/api/me");
    expect(me.status()).toBe(200);
    expect(me.headers()["x-ratelimit-remaining"]).toMatch(/^\d+$/);
    expect(me.headers()["x-ratelimit-limit"]).toMatch(/^\d+$/);

    // Fresh user: the dashboard shows the template gallery; pick Meeting notes.
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("empty-state").getByTestId("template-meeting-notes").click();
    await page.waitForURL(/\/d\/[^/]+$/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.getByTestId("title")).toHaveText("Meeting notes");
    await expect.poll(() => codeText(page)).toContain("## Action items");

    // Type one line in the rich pane; the code pane (Y.Text) must follow.
    await page.locator(".md-rich").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Typed in the rich pane on the production build.");
    await expect.poll(() => codeText(page)).toContain("Typed in the rich pane on the production build.");

    // Type one line in the code pane; the rich pane must follow.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\nTyped in the code pane on the production build.\n");
    await expect.poll(() => richText(page)).toContain("Typed in the code pane on the production build.");

    // Edits went over the WebSocket and were persisted by the server.
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    const id = page.url().match(/\/d\/([^/?#]+)/)![1];
    const content = await page.request.get(`/api/documents/${id}/content`);
    expect(content.status()).toBe(200);
    const text = await content.text();
    expect(text).toContain("Typed in the rich pane on the production build.");
    expect(text).toContain("Typed in the code pane on the production build.");
  });

  /**
   * Real mouse clicks on controls that ignored every click on a production build (#2197). Five handlers
   * accepted only a React event whose constructor was named "SyntheticBaseEvent", a name minification
   * changes; the dashboard create buttons lost their click proof to a microtask that a real browser runs
   * between React's capture and bubble listeners. jsdom stayed green for both. Each test proves the click
   * with what the user sees and, where there is one, with the server's own record.
   */
  test.describe("real clicks (#2197)", () => {
    const docIdOf = (page: Page) => new URL(page.url()).pathname.match(/^\/d\/([^/]+)$/)![1];

    /** A user of its own on a hydrated dashboard: a click that lands before hydration is dropped and would prove nothing. */
    async function signInFresh(page: Page, prefix: string) {
      await devLogin(page, uniqueLogin(prefix));
      await waitForHydration(page);
    }

    async function serverText(page: Page, id: string): Promise<string> {
      const res = await page.request.get(`/api/documents/${id}/content`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { content: string }).content;
    }

    async function threadsOf(page: Page, id: string) {
      const res = await page.request.get(`/api/documents/${id}/comments`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { comments: { id: string; resolved: boolean; suggestion: { state: string } | null }[] }).comments;
    }

    const storedTheme = (page: Page) => page.evaluate(() => localStorage.getItem("markdoc:theme"));

    test("the header theme toggle and the Settings theme picker change the theme", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await signInFresh(page, "prod-theme");
      const html = page.locator("html");
      const toggle = page.getByTestId("theme-toggle");
      await expect(toggle).toHaveAttribute("data-theme-preference", "system");
      await expect(html).toHaveAttribute("data-theme", "dark");

      for (const [preference, resolved] of [
        ["light", "light"],
        ["dark", "dark"],
        ["system", "dark"],
      ] as const) {
        await toggle.click();
        await expect(toggle).toHaveAttribute("data-theme-preference", preference);
        await expect(html).toHaveAttribute("data-theme", resolved);
        expect(await storedTheme(page)).toBe(preference);
      }

      await page.goto("/settings");
      await waitForHydration(page);
      for (const [preference, resolved] of [
        ["light", "light"],
        ["dark", "dark"],
        ["system", "dark"],
      ] as const) {
        const option = page.getByTestId(`theme-option-${preference}`);
        await option.click();
        await expect(option).toHaveAttribute("aria-checked", "true");
        await expect(html).toHaveAttribute("data-theme", resolved);
        expect(await storedTheme(page)).toBe(preference);
      }
    });

    test("the editor status bar theme toggle cycles System, Light, Dark, System", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await signInFresh(page, "prod-theme-editor");
      const id = await createDocument(page, "# Smoke theme\n\nThe status bar toggle.\n", "Smoke theme");
      await openDocument(page, id);
      const html = page.locator("html");
      const toggle = page.getByTestId("status-bar").getByTestId("theme-toggle");
      await expect(toggle).toHaveAttribute("data-theme-preference", "system");
      await expect(html).toHaveAttribute("data-theme", "dark");

      for (const [preference, resolved] of [
        ["light", "light"],
        ["dark", "dark"],
        ["system", "dark"],
      ] as const) {
        await toggle.click();
        await expect(toggle).toHaveAttribute("data-theme-preference", preference);
        await expect(html).toHaveAttribute("data-theme", resolved);
        expect(await storedTheme(page)).toBe(preference);
      }
    });

    test("the command palette closes on Escape and on an outside click and gives focus back (#2216)", async ({ page }) => {
      await signInFresh(page, "prod-palette-dismiss");
      const id = await createDocument(page, "# Smoke palette\n\nThe command palette.\n", "Smoke palette");
      await openDocument(page, id);
      const palette = page.getByTestId("command-palette");
      const more = page.getByTestId("more-menu");

      // More > Search commands with Enter, then Escape: focus goes back to More.
      await more.focus();
      await page.keyboard.press("Enter");
      await page.getByTestId("menu-command-palette").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("palette-input")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      await expect(more).toBeFocused();

      // The keyboard shortcut in the editor, then a real click outside: focus goes back to the editor.
      const rich = page.locator(".md-rich");
      await page.locator(".md-rich p").first().click();
      await page.keyboard.press("Control+Shift+P");
      await expect(page.getByTestId("palette-input")).toBeFocused();
      await page.mouse.click(24, page.viewportSize()!.height - 24);
      await expect(palette).toHaveCount(0);
      await expect(rich).toBeFocused();

      // The next click lands on the first try.
      await page.getByTestId("share-button").click();
      await expect(page.getByTestId("share-connect-agent")).toBeVisible();
    });

    test("the comments tabs change on a click and on the arrow, Home and End keys (#2198)", async ({ page }) => {
      await signInFresh(page, "prod-tabs");
      const id = await createDocument(page, "# Smoke tabs\n\nThe comments tabs.\n", "Smoke tabs");
      await openDocument(page, id);
      await ensureCommentsOpen(page);
      await expectCommentsTab(page, "open");

      for (const tab of ["resolved", "suggestions", "open"] as const) {
        await page.getByTestId(`comments-tab-${tab}`).click();
        await expectCommentsTab(page, tab, { focused: true });
      }
      for (const [key, tab] of [
        ["ArrowRight", "resolved"],
        ["ArrowLeft", "open"],
        ["ArrowLeft", "suggestions"],
        ["Home", "open"],
        ["End", "suggestions"],
      ] as const) {
        await page.keyboard.press(key);
        await expectCommentsTab(page, tab, { focused: true });
      }

      await page.getByRole("button", { name: "Close comments" }).click();
      await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    });

    test("the Close comments button closes the sheet at phone width (#2198)", async ({ page }) => {
      await signInFresh(page, "prod-close-phone");
      await page.setViewportSize({ width: 390, height: 844 });
      const id = await createDocument(page, "# Smoke close\n\nThe phone sheet.\n", "Smoke close");
      await openPhoneComments(page, id);
      await page.getByTestId("comments-tab-suggestions").click();
      await expectCommentsTab(page, "suggestions", { focused: true });

      await page.getByRole("button", { name: "Close comments" }).click();
      await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    });

    test("the Settings theme picker follows the arrow keys and saves the theme (#2198)", async ({ page }) => {
      await signInFresh(page, "prod-picker-keys");
      await page.goto("/settings");
      await waitForHydration(page);
      await page.getByTestId("theme-option-system").focus();

      for (const [key, preference] of [
        ["ArrowLeft", "dark"],
        ["ArrowRight", "system"],
        ["ArrowDown", "light"],
        ["End", "dark"],
        ["Home", "system"],
      ] as const) {
        await page.keyboard.press(key);
        await expectThemeOption(page, preference);
      }
    });

    test("Trash: Restore brings a document back and Delete forever removes it", async ({ page }) => {
      await signInFresh(page, "prod-trash");
      const title = `Disposable ${Date.now().toString(36)}`;
      const id = await createDocument(page, `# ${title}\n\nThrow me away.\n`, title);
      const openTrash = async () => {
        await page.goto("/");
        await waitForHydration(page);
        await page.getByTestId("filter-trash").click();
        const card = page.getByTestId("trash-card").filter({ hasText: title });
        await expect(card).toHaveCount(1);
        return card;
      };

      expect((await page.request.delete(`/api/documents/${id}`)).ok()).toBeTruthy();
      const card = await openTrash();
      await card.getByTestId("restore-button").click();
      await expect(card).toHaveCount(0);
      expect((await page.request.get(`/api/documents/${id}`)).status()).toBe(200);
      await page.getByTestId("filter-all").click();
      await expect(page.getByTestId("document-card").filter({ hasText: title })).toHaveCount(1);

      expect((await page.request.delete(`/api/documents/${id}`)).ok()).toBeTruthy();
      const again = await openTrash();
      page.once("dialog", (dialog) => dialog.accept());
      await again.getByTestId("purge-button").click();
      await expect(again).toHaveCount(0);
      const trash = (await (await page.request.get("/api/documents?trash=1")).json()) as { documents: { id: string }[] };
      expect(trash.documents.map((d) => d.id)).not.toContain(id);
      expect((await page.request.get(`/api/documents/${id}`)).status()).toBe(404);
    });

    test("a review card expands, and its Accept all, Reject all and Resolve all buttons act", async ({ page }) => {
      await signInFresh(page, "prod-review");
      const id = await createDocument(page, "# Smoke review\n\nOur product is very unique.\n\nWe launched recently and sales are good.\n\nThe end is near.\n", "Smoke review");
      const agent = await mintToken(page, "Smoke Reviewer", { expiresInDays: 1 });
      const postReview = async (summary: string, comments: { quote: string; body: string }[]) => {
        const res = await page.request.post(`/api/documents/${id}/reviews`, {
          headers: { Authorization: ["Bearer", agent.token].join(" "), "Content-Type": "application/json" },
          data: { summary, verdict: "comment", comments },
        });
        expect(res.status(), await res.text()).toBe(201);
        return ((await res.json()) as { review: { id: string; threadIds: string[] } }).review;
      };
      const accept = await postReview("Softer close.", [{ quote: "The end is near.", body: "Softer.\n\n```suggestion\nThat is all for now.\n```" }]);
      const reject = await postReview("Tighter wording.", [{ quote: "very unique", body: "Redundant.\n\n```suggestion\nunique\n```" }]);
      const resolve = await postReview("Just a note.", [{ quote: "sales are good", body: "Nice numbers." }]);
      const cardOf = (reviewId: string) => page.locator(`[data-testid="review-card"][data-review-id="${reviewId}"]`);

      await openDocument(page, id);
      await ensureCommentsOpen(page);

      const acceptCard = cardOf(accept.id);
      await acceptCard.getByTestId("review-toggle").click();
      await expect(acceptCard.getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "true");
      await expect(acceptCard.getByTestId("review-thread-link")).toHaveCount(1);
      await acceptCard.getByTestId("review-accept-all").click();
      await expect(page.getByTestId("toast")).toContainText(`Accepted 1 suggestion from ${agent.name}`);
      await expect.poll(() => serverText(page, id), { timeout: 30_000 }).toContain("That is all for now.");
      expect(await serverText(page, id)).not.toContain("The end is near.");

      await cardOf(reject.id).getByTestId("review-reject-all").click();
      await expect
        .poll(async () => (await threadsOf(page, id)).find((t) => t.id === reject.threadIds[0])?.suggestion?.state, { timeout: 30_000 })
        .toBe("rejected");
      expect(await serverText(page, id)).toContain("Our product is very unique.");

      await cardOf(resolve.id).getByTestId("review-resolve-all").click();
      await expect.poll(async () => (await threadsOf(page, id)).find((t) => t.id === resolve.threadIds[0])?.resolved, { timeout: 30_000 }).toBe(true);
      await agent.revoke();
    });

    test("Cancel on a waiting request in the presence popover cancels it", async ({ page }) => {
      await signInFresh(page, "prod-request");
      const id = await createDocument(page, "# Smoke request\n\nTighten this sentence please.\n", "Smoke request");
      await openDocument(page, id);
      const posted = await page.request.post(`/api/documents/${id}/requests`, { data: { instruction: "Tighten this", mode: "suggest" } });
      expect(posted.status()).toBe(201);
      const request = ((await posted.json()) as { request: { id: string } }).request;

      await expect(page.getByTestId("presence").getByTestId("presence-waiting")).toBeVisible();
      await page.getByTestId("presence").click();
      await expect(page.getByTestId("presence-requests")).toBeVisible();
      await page.getByTestId("presence-request-cancel").first().click();
      await expect(page.getByTestId("presence-requests")).toHaveCount(0);
      await expect(page.getByTestId("presence").getByTestId("presence-waiting")).toHaveCount(0);
      // The popover hides the row at once; the cancel reaches the server on its own request.
      await expect
        .poll(
          async () => {
            const listed = (await (await page.request.get(`/api/documents/${id}/requests`)).json()) as { requests: { id: string; status: string }[] };
            return listed.requests.find((r) => r.id === request.id)?.status;
          },
          { timeout: 30_000 },
        )
        .toBe("cancelled");
    });

    test("New document creates a document and opens it", async ({ page }) => {
      await signInFresh(page, "prod-new");
      const created = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/documents");
      await page.getByTestId("new-document").click();
      expect((await created).status()).toBe(201);
      await page.waitForURL(/\/d\/[a-z0-9]+$/i);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      expect((await page.request.get(`/api/documents/${docIdOf(page)}`)).status()).toBe(200);
    });

    test("Start with a guided doc creates the Welcome doc and opens it", async ({ page }) => {
      await signInFresh(page, "prod-guided");
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await page.getByTestId("start-guided-doc").click();
      await page.waitForURL(/\/d\/[a-z0-9]+$/i);
      await expect(page.getByTestId("title")).toContainText("Welcome to Markdoc");
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      expect((await page.request.get(`/api/documents/${docIdOf(page)}`)).status()).toBe(200);
    });

    // A production server answers the create before the second click of a double click lands. The
    // buttons must stay busy until the document page replaces the dashboard, or that click makes a
    // second document.
    for (const { name, testid, prefix } of [
      { name: "New document", testid: "new-document", prefix: "prod-double-new" },
      { name: "Start with a guided doc", testid: "start-guided-doc", prefix: "prod-double-guided" },
    ]) {
      test(`a fast real double click on ${name} creates exactly one document`, async ({ page }) => {
        await signInFresh(page, prefix);
        await expect(page.getByTestId("empty-state")).toBeVisible();
        let posts = 0;
        page.on("request", (req) => {
          if (req.method() === "POST" && new URL(req.url()).pathname === "/api/documents") posts += 1;
        });

        const box = (await page.getByTestId(testid).boundingBox())!;
        await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 20 });
        await page.waitForURL(/\/d\/[a-z0-9]+$/i);
        await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

        const listed = (await (await page.request.get("/api/documents")).json()) as { documents: { id: string }[] };
        expect.soft(posts, "POST /api/documents requests").toBe(1);
        expect(listed.documents.map((d) => d.id), "the user's documents").toEqual([docIdOf(page)]);
      });
    }

    test("Sign in with GitHub in the Open from GitHub dialog starts the GitHub sign-in", async ({ page }) => {
      await signInFresh(page, "prod-github");
      const card = page.getByTestId("open-github");
      await expect(card).toBeVisible();
      test.skip(await card.isDisabled(), "this server has no GitHub OAuth app (AUTH_GITHUB_ID / AUTH_GITHUB_SECRET)");

      await card.click();
      const dialog = page.getByRole("dialog", { name: "Open from GitHub" });
      await expect(dialog).toBeVisible();
      // github.com itself is never reached: the stub proves the browser was sent to the authorize URL.
      await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>github stub</title>" }));
      const authorize = page.waitForRequest((req) => req.url().startsWith("https://github.com/login/oauth/authorize"));
      await dialog.getByRole("button", { name: /Sign in with GitHub/ }).click();
      const url = new URL((await authorize).url());
      expect(url.searchParams.get("client_id")).toBeTruthy();
      expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/auth\/callback\/github$/);
    });
  });

  test.describe("image dialog real input (#2193)", () => {
    test.skip(!base, "PROD_BASE_URL not set");
    test.use({ baseURL: base ?? "http://localhost:3900" });

    test("Upload, typed URL and alt text, Insert, Cancel and Escape work with real input", async ({ page }) => {
      await devLogin(page, uniqueLogin("prod-image"));
      const id = await createDocument(page, "# Images\n\nGallery.\n", "Images");
      await openDocument(page, id);
      await page.locator(".md-rich").click();
      await page.keyboard.press("Control+End");

      await page.getByTestId("tb-image").click();
      const dialog = page.getByRole("dialog", { name: "Insert image" });
      await expect(dialog).toBeVisible();
      const chooser = page.waitForEvent("filechooser");
      await page.getByTestId("image-upload").click();
      await (await chooser).setFiles({
        name: "Smoke pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
      });
      await expect(page.getByTestId("image-url")).toHaveValue(/^\/api\/assets\/[a-z0-9]+$/);
      const uploaded = await page.getByTestId("image-url").inputValue();
      await page.getByTestId("image-alt").click();
      await page.keyboard.press("Control+A");
      await page.keyboard.type("Uploaded pixel");
      await page.getByTestId("image-submit").click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => codeText(page)).toContain(`![Uploaded pixel](${uploaded})`);

      await page.getByTestId("tb-image").click();
      await page.getByTestId("image-url").click();
      await page.keyboard.type(uploaded);
      await page.getByTestId("image-alt").click();
      await page.keyboard.type("Keyboard pixel");
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => codeText(page)).toContain(`![Keyboard pixel](${uploaded})`);

      const beforeCancel = await codeText(page);
      await page.getByTestId("tb-image").click();
      await page.getByTestId("image-url").click();
      await page.keyboard.type(uploaded);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByTestId("tb-image").click();
      await expect(page.getByTestId("image-url")).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await codeText(page)).toBe(beforeCancel);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      const content = await page.request.get(`/api/documents/${id}/content`);
      expect(content.status()).toBe(200);
      expect(((await content.json()) as { content: string }).content).toContain(`![Keyboard pixel](${uploaded})`);
    });
  });
});
