import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText } from "./helpers";

// GitHub is an in-memory fake in the e2e server (GITHUB_MOCK=1, see src/server/github/mock.ts); the
// header polls /sync every 2 s (SYNC_POLL_MS) and the server-side remote cache is 500 ms.

const BASE = "# Sync test\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
const REPO = { owner: "mock", repo: "scratch", branch: "main" };
let n = 0;

async function linkToFakeRepo(page: Page, docId: string, content = BASE) {
  const path = `docs/sync-${Date.now()}-${++n}.md`;
  const seed = await page.request.post("/api/github/mock", { data: { kind: "repo", ...REPO, path, content } });
  expect(seed.ok()).toBeTruthy();
  const res = await page.request.post(`/api/documents/${docId}/link`, { data: { storage: "repo", ...REPO, path } });
  expect(res.ok()).toBeTruthy();
  return path;
}

const setRemote = async (page: Page, path: string, content: string) => {
  const res = await page.request.post("/api/github/mock", { data: { kind: "repo", ...REPO, path, content } });
  expect(res.ok()).toBeTruthy();
};
const remote = async (page: Page, path: string) => {
  const res = await page.request.get(`/api/github/mock?owner=${REPO.owner}&repo=${REPO.repo}&branch=${REPO.branch}&path=${encodeURIComponent(path)}`);
  return ((await res.json()) as { content: string | null }).content;
};
const status = (page: Page) => page.getByTestId("publish-status");

async function typeAtEnd(page: Page, text: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
}

test.describe("GitHub sync", () => {
  test("status follows publish, remote edits and local edits; merge joins different paragraphs", async ({ browser }) => {
    const { page } = await signIn(browser, "syncer");
    const docId = await createDocument(page, BASE);
    const path = await linkToFakeRepo(page, docId);
    await openDocument(page, docId);

    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });
    await expect(status(page)).toHaveText("Up to date");

    // Someone else commits → "GitHub has changes" and the button becomes Pull.
    const remoteEdit = BASE.replace("Third paragraph.", "Third paragraph, edited on GitHub.");
    await setRemote(page, path, remoteEdit);
    await expect(status(page)).toHaveAttribute("data-status", "remote-ahead", { timeout: 65_000 });
    await expect(status(page)).toHaveText("Pull");

    // Edit locally too → "Both changed"; the button opens the Sync dialog.
    await typeAtEnd(page, "\nA new local line.");
    await expect(status(page)).toHaveAttribute("data-status", "diverged", { timeout: 15_000 });
    await expect(status(page)).toHaveText("Both changed");
    await page.getByTestId("publish-button").click();
    const dialog = page.getByTestId("sync-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-status", "diverged");
    await expect(page.getByTestId("sync-local-lines")).toContainText("changed");
    await expect(page.getByTestId("sync-remote-lines")).toContainText("1 line changed");

    // Merge: different paragraphs → clean merge, text has both edits, no markers.
    await page.getByTestId("sync-merge").click();
    await expect(page.getByTestId("sync-done")).toContainText("Merged");
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect.poll(() => codeText(page)).toContain("edited on GitHub");
    expect(await codeText(page)).toContain("A new local line.");
    expect(await codeText(page)).not.toContain("<<<<<<<");
    await expect(status(page)).toHaveAttribute("data-status", "local-ahead", { timeout: 15_000 });
    await expect(status(page)).toHaveText("Publish");

    // Publish the merge → up to date, and the fake repo has the merged text.
    await page.getByTestId("publish-button").click();
    await page.getByTestId("commit-submit").click();
    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });
    const published = await remote(page, path);
    expect(published).toContain("edited on GitHub");
    expect(published).toContain("A new local line.");
  });

  test("same-line conflict puts markers in the editor and the linter counts them", async ({ browser }) => {
    const { page } = await signIn(browser, "syncer2");
    const docId = await createDocument(page, BASE);
    const path = await linkToFakeRepo(page, docId);
    await openDocument(page, docId);
    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });

    await setRemote(page, path, BASE.replace("Second paragraph.", "Second paragraph (theirs)."));
    // Change the same line locally: select "Second paragraph." in the code pane and replace it.
    await page.locator(".cm-content").click();
    await page.evaluate(() => {
      const s = (window as unknown as { __markdocSession: { ytext: { toString(): string }; replaceSource(e: { from: number; to: number; text: string }[]): void } }).__markdocSession;
      const src = s.ytext.toString();
      const from = src.indexOf("Second paragraph.");
      s.replaceSource([{ from, to: from + "Second paragraph.".length, text: "Second paragraph (mine)." }]);
    });
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    await expect(status(page)).toHaveAttribute("data-status", "diverged", { timeout: 65_000 });

    await page.getByTestId("publish-button").click();
    await page.getByTestId("sync-merge").click();
    await expect(page.getByTestId("sync-done")).toContainText("1 conflict");
    await expect.poll(() => codeText(page)).toContain("<<<<<<< local");
    const text = await codeText(page);
    expect(text).toContain("Second paragraph (mine).\n=======\nSecond paragraph (theirs).\n>>>>>>> github");
    // Three marker lines → three `merge-conflict` errors (plus `multiple-h1`: `=======` reads as a setext underline).
    await expect(page.getByTestId("issues-button")).toHaveText(/[3-9] issues/, { timeout: 10_000 });
    await page.getByTestId("issues-button").click();
    await expect(page.getByText("Merge conflict start marker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-content")).toContainText("<<<<<<< local");
  });

  test("Keep mine force-publishes the local text over GitHub", async ({ browser }) => {
    const { page } = await signIn(browser, "syncer3");
    const docId = await createDocument(page, BASE);
    const path = await linkToFakeRepo(page, docId);
    await openDocument(page, docId);
    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });

    await setRemote(page, path, BASE.replace("First paragraph.", "First paragraph (theirs)."));
    await typeAtEnd(page, "\nMine wins.");
    await expect(status(page)).toHaveAttribute("data-status", "diverged", { timeout: 65_000 });

    await page.getByTestId("publish-button").click();
    await page.getByTestId("sync-keep-mine").click();
    await expect(page.getByTestId("sync-done")).toContainText("Published");
    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });
    const published = await remote(page, path);
    expect(published).toContain("Mine wins.");
    expect(published).not.toContain("(theirs)");
  });

  test("Take GitHub force-pulls; Compare shows the remote diff", async ({ browser }) => {
    const { page } = await signIn(browser, "syncer4");
    const docId = await createDocument(page, BASE);
    const path = await linkToFakeRepo(page, docId);
    await openDocument(page, docId);
    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });

    await setRemote(page, path, BASE.replace("First paragraph.", "First paragraph (theirs)."));
    await typeAtEnd(page, "\nLocal only.");
    await expect(status(page)).toHaveAttribute("data-status", "diverged", { timeout: 65_000 });

    await page.getByTestId("publish-button").click();
    await page.getByTestId("sync-compare").click();
    await expect(page.getByTestId("version-diff")).toBeVisible();
    await expect(page.getByTestId("sync-compare-bar")).toBeVisible();
    await page.getByTestId("sync-compare-close").click();
    await expect(page.locator(".cm-content")).toBeVisible();

    await page.getByTestId("publish-button").click();
    await page.getByTestId("sync-take-remote").click();
    await expect(page.getByTestId("sync-done")).toContainText("GitHub");
    await expect.poll(() => codeText(page)).toContain("(theirs)");
    expect(await codeText(page)).not.toContain("Local only.");
    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });
  });
});

// The e2e server has a (fake) GitHub OAuth app configured (playwright.config.ts) but dev-login users
// hold no GitHub token, so every GitHub dialog opens on its empty state. That state must carry the
// action it names instead of dead-ending on Close (#162).
test.describe("GitHub dialogs without a GitHub account (#162)", () => {
  const signInButton = (page: Page) => page.getByRole("dialog").getByRole("button", { name: /Sign in with GitHub/ });

  test("dashboard card, ⋮ → Connect to GitHub… and Publish ▾ → Gist or repository… all offer Sign in with GitHub", async ({ browser }) => {
    const { page } = await signIn(browser, "nogithub");

    const card = page.getByTestId("open-github");
    await expect(card).toBeEnabled();
    await expect(card).toContainText("Edit a Markdown file from a gist or repository.");
    await card.click();
    const dashboardDialog = page.getByRole("dialog", { name: "Open from GitHub" });
    await expect(dashboardDialog).toBeVisible();
    await expect(signInButton(page)).toBeVisible();
    await expect(dashboardDialog.getByTestId("github-not-configured")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dashboardDialog).toHaveCount(0);

    const docId = await createDocument(page, BASE);
    await openDocument(page, docId);

    await page.getByTestId("more-menu").click();
    const connect = page.getByRole("menuitem", { name: "Connect to GitHub…" });
    await expect(connect).toBeVisible();
    await expect(connect).not.toHaveAttribute("data-disabled");
    await connect.click();
    const editorDialog = page.getByRole("dialog", { name: "Connect to GitHub" });
    await expect(editorDialog).toBeVisible();
    await expect(signInButton(page)).toBeVisible();
    // Keyboard: Tab reaches the sign-in button, not only Close.
    await signInButton(page).focus();
    await expect(signInButton(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editorDialog).toHaveCount(0);

    await page.getByTestId("publish-menu").click();
    const gistOrRepo = page.getByRole("menuitem", { name: "Gist or repository…" });
    await expect(gistOrRepo).not.toHaveAttribute("data-disabled");
    await gistOrRepo.click();
    await expect(editorDialog).toBeVisible();
    await expect(signInButton(page)).toBeVisible();

    // The button really starts the GitHub sign-in: the server answers with the GitHub authorize URL,
    // which carries the e2e client id and a callback to this server. github.com itself is never reached.
    await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>github stub</title>" }));
    const authorize = page.waitForRequest((req) => req.url().startsWith("https://github.com/login/oauth/authorize"));
    await signInButton(page).click();
    const url = new URL((await authorize).url());
    expect(url.searchParams.get("client_id")).toBe("e2e-github-oauth-app");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/auth\/callback\/github$/);
  });
});
