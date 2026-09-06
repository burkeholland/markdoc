import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  signIn,
  createDocument,
  openDocument,
  shareWith,
  selectTextInRich,
  ensureCommentsOpen,
  mintToken,
  waitForHydration,
  reloadHydrated,
  type MintedToken,
  type User,
} from "./helpers";

// This suite mints local fixture tokens; never retain their network payloads in traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * Agent addressing, the UI half (task #1330 on top of #1296): someone else's agent is named with its owner
 * ("alice's Scribe") wherever it shows, the `@` picker greys out an agent whose owner keeps it to themself and the
 * composer refuses to send before the server would answer 403, and the owner opens it from Settings → Agents with
 * the "Collaborators may ask this agent" switch. Two users: alice owns the document and the agent, bob edits.
 * Dev-login users have their login as display name, so the owner reads as "alice" here.
 */

interface RequestDto {
  id: string;
  status: string;
  mode: string;
  claimedBy: string | null;
  claimedByLogin?: string | null;
  agent?: { login: string; slug: string } | null;
  instruction: string;
  threadId: string | null;
}

/** Act as alice's agent: the REST the CLI uses through mcp/server.mjs, with the token minted below. */
function agent(page: Page, token: string) {
  const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
  const call = async <T,>(path: string, data?: unknown): Promise<T> => {
    const res = await page.request.post(path, { headers, data: data ?? {} });
    expect(res.ok(), `POST ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as T;
  };
  return {
    /** A heartbeat: the agent is in the document (so the picker offers it to everyone) for the presence TTL (90 s). */
    here: (docId: string, status: string) => call(`/api/agent/documents/${docId}/presence`, { state: "active", status }),
    claim: (docId: string, rid: string) => call<{ request: RequestDto }>(`/api/documents/${docId}/requests/${rid}/claim`),
    suggest: (docId: string, rid: string, edits: { find: string; replace: string }[]) => call<{ suggestions: number }>(`/api/documents/${docId}/suggest`, { edits, requestId: rid }),
    complete: (docId: string, rid: string, summary: string) => call<{ request: RequestDto }>(`/api/documents/${docId}/requests/${rid}/complete`, { summary }),
  };
}

/** The document's requests as a browser session sees them. */
async function listRequests(page: Page, docId: string, status?: string): Promise<RequestDto[]> {
  const res = await page.request.get(`/api/documents/${docId}/requests${status ? `?status=${status}` : ""}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { requests: RequestDto[] }).requests;
}

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/agent-addressing-${name}.png` });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DOC = "# Addressing doc\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph to keep.\n";

test.describe("agent addressing (UI): owner-labelled names, locked agents, collaborators may ask", () => {
  // 2) opens the agent that 1) found locked and 3) claims the request 2) posted: a failure upstream skips the rest.
  test.describe.configure({ mode: "serial" });
  let alice: User;
  let bob: User;
  let docId: string;
  let minted: MintedToken;
  /** Unique per run: token names are unique per user, and other suites mint "Copilot CLI …" for alice. */
  const agentName = `Scribe ${Date.now().toString(36).slice(-4)}`;
  const slug = agentName.replace(/[^A-Za-z0-9-]+/g, "-");
  const mention = `@alice/${slug}`;
  /** How bob reads alice's agent; alice reads it as `agentName`. */
  const labelled = `alice's ${agentName}`;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    minted = await mintToken(alice.page, agentName, { expiresInDays: 1 });
    expect(minted.name).toBe(agentName);
    docId = await createDocument(alice.page, DOC, "Addressing doc");
    await shareWith(alice.page, docId, "bob", "editor");
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice.context.close();
    await bob.context.close();
  });

  /** Opens bob's new-comment composer on `text` and types `@scr`; returns the composer and the one option it finds. */
  async function openPickerAsBob(text: string) {
    const page = bob.page;
    await selectTextInRich(page, text);
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await page.keyboard.type("@scr");
    const options = page.getByTestId("mention-suggestions").getByTestId("mention-option");
    await expect(options).toHaveCount(1);
    const option = options.first();
    await expect(option).toHaveAttribute("data-login", `alice/${slug}`);
    await expect(option).not.toHaveAttribute("data-own", "");
    return { composer, option };
  }

  test("1) a collaborator sees the owner's agent greyed out with a lock and the reason; picking it mentions, but the composer refuses to send and no request is created", async () => {
    const page = bob.page;
    const bot = agent(alice.page, minted.token);
    await bot.here(docId, "reading");
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    // The header names it for bob with its owner.
    await expect(page.getByTestId("presence")).toHaveAttribute("aria-label", new RegExp(`${escapeRe(labelled)} \\(agent`));

    const { composer, option } = await openPickerAsBob("quick brown fox");
    await expect(option).toHaveAttribute("aria-disabled", "true");
    await expect(option).toHaveAttribute("data-locked", "");
    await expect(option).toHaveAttribute("title", "Only alice can ask this agent");
    await expect(option).toContainText(labelled);
    await expect(option).toContainText("owner only");
    // Exactly one locked row: the two people are never locked.
    await expect(page.locator('[data-testid="mention-option"][data-locked]')).toHaveCount(1);
    await shot(page, "picker-locked");

    // Picking it is allowed (the mention itself is legitimate) — by keyboard, as Playwright will not click an aria-disabled row.
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue(`${mention} `);
    await page.keyboard.type("tighten this");
    const row = page.getByTestId("composer-agent-row");
    await expect(row).toBeVisible();
    await expect(row.getByRole("radiogroup")).toHaveAttribute("aria-label", `How should ${labelled} answer?`);
    const notice = page.getByTestId("agent-owner-only");
    await expect(notice).toHaveText(`${labelled} only takes requests from alice.`);
    // Under the row, not in it: the row stays controls only.
    expect(await row.evaluate((el) => el.nextElementSibling?.getAttribute("data-testid"))).toBe("agent-owner-only");
    await expect(page.getByTestId("comment-submit")).toBeDisabled();
    await shot(page, "composer-refused");
    // Enter does nothing either: no comment, no request — the server never sees a 403 round trip.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await expect(page.getByTestId("comment-thread")).toHaveCount(0);
    expect(await listRequests(alice.page, docId)).toEqual([]);
    // Drop the draft so the next test starts clean.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pending-comment")).toHaveCount(0);
  });

  test("2) the owner turns 'Collaborators may ask this agent' on in Settings → Agents: exactly one PATCH, the API agrees, and the collaborator's ask then goes through to that agent", async () => {
    const page = alice.page;
    await page.goto("/settings");
    // The switch is a client handler: a click before hydration is dropped (e2e rule since #1263).
    await waitForHydration(page);
    const tokenRow = page.getByTestId("token-row").filter({ hasText: agentName }).first();
    await tokenRow.getByText("Details & agent requests", { exact: true }).click();
    const toggle = tokenRow.getByTestId("token-collaborators-may-ask");
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAccessibleName("Collaborators may ask this agent");
    await expect(tokenRow).toContainText("Off: only you can send requests to it. On: people you share documents with can too.");
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && new URL(req.url()).pathname === `/api/tokens/${minted.id}`) patches.push(req.postData() ?? "");
    });
    const [response] = await Promise.all([page.waitForResponse((res) => res.request().method() === "PATCH" && new URL(res.url()).pathname === `/api/tokens/${minted.id}`), toggle.click()]);
    expect(response.status()).toBe(200);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(300);
    expect(patches).toEqual([JSON.stringify({ collaboratorsMayAsk: true })]);
    await expect(tokenRow.getByRole("alert")).toHaveCount(0);
    // The API agrees, and the switch survives a reload.
    const listed = await page.request.get("/api/tokens");
    expect(listed.ok()).toBeTruthy();
    const { tokens } = (await listed.json()) as { tokens: { id: string; collaboratorsMayAsk: boolean }[] };
    expect(tokens.find((t) => t.id === minted.id)?.collaboratorsMayAsk).toBe(true);
    await reloadHydrated(page);
    await tokenRow.getByText("Details & agent requests", { exact: true }).click();
    await expect(page.getByTestId("token-row").filter({ hasText: agentName }).first().getByTestId("token-collaborators-may-ask")).toHaveAttribute("aria-checked", "true");
    await shot(page, "settings-switch-on");

    // Bob's picker learns of it with the document (the collaborators route is read when the panel opens).
    const bot = agent(alice.page, minted.token);
    await bot.here(docId, "reading");
    await openDocument(bob.page, docId);
    await ensureCommentsOpen(bob.page);
    const { composer, option } = await openPickerAsBob("quick brown fox");
    await expect(option).not.toHaveAttribute("aria-disabled", "true");
    await expect(option).not.toHaveAttribute("data-locked", "");
    await expect(option).toContainText(labelled);
    await expect(option).not.toContainText("owner only");
    await bob.page.keyboard.press("Enter");
    await expect(composer).toHaveValue(`${mention} `);
    await bob.page.keyboard.type("tighten this");
    await expect(bob.page.getByTestId("composer-agent-row")).toBeVisible();
    await expect(bob.page.getByTestId("agent-owner-only")).toHaveCount(0);
    await expect(bob.page.getByTestId("comment-submit")).toBeEnabled();
    await bob.page.getByTestId("comment-submit").click();
    const thread = bob.page.getByTestId("comment-thread").filter({ hasText: "tighten this" });
    await expect(thread).toHaveCount(1);
    const chip = thread.getByTestId("comment-request-chip");
    await expect(chip).toHaveAttribute("data-status", "open");
    await expect(chip).toContainText("Waiting for an agent");
    await expect(bob.page.getByTestId("toast").filter({ hasText: "refused" })).toHaveCount(0);
    // Exactly one request, addressed to alice's agent, on the thread.
    const threadId = await thread.getAttribute("data-thread-id");
    const open = await listRequests(alice.page, docId, "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ mode: "suggest", instruction: "tighten this", threadId, agent: { login: "alice", slug: slug.toLowerCase() } });
  });

  test("3) once alice's agent claims it, bob reads \"alice's <Name> is working…\" and alice reads \"<Name> is working…\" — chip, header badge and the finished toast", async () => {
    const [request] = await listRequests(alice.page, docId, "open");
    expect(request).toBeTruthy();
    const bot = agent(alice.page, minted.token);
    await bot.here(docId, "reading");
    await openDocument(alice.page, docId);
    await ensureCommentsOpen(alice.page);
    await bot.claim(docId, request.id);

    const bobChip = bob.page.getByTestId("comment-thread").filter({ hasText: "tighten this" }).getByTestId("comment-request-chip");
    await expect(bobChip).toHaveAttribute("data-status", "claimed");
    await expect(bobChip).toContainText(`${labelled} is working…`);
    const aliceChip = alice.page.getByTestId("comment-thread").filter({ hasText: "tighten this" }).getByTestId("comment-request-chip");
    await expect(aliceChip).toHaveAttribute("data-status", "claimed");
    await expect(aliceChip).toContainText(`${agentName} is working…`);
    await expect(aliceChip).not.toContainText("alice's");
    // The header's busy badge on the agent's avatar reads the same way for each of them.
    await expect(bob.page.getByTestId("presence-avatar-busy")).toHaveAttribute("aria-label", `${labelled} is working`);
    await expect(alice.page.getByTestId("presence-avatar-busy")).toHaveAttribute("aria-label", `${agentName} is working`);
    await shot(bob.page, "chip-working-collaborator");
    await shot(alice.page, "chip-working-owner");

    const suggested = await bot.suggest(docId, request.id, [{ find: "quick brown fox", replace: "swift brown fox" }]);
    expect(suggested.suggestions).toBeGreaterThan(0);
    await bot.complete(docId, request.id, "Tightened the opener.");
    // The requester's toast: bob asked, so bob hears "alice's Scribe finished".
    await expect(bob.page.getByTestId("toast").filter({ hasText: `${labelled} finished` })).toBeVisible();
    await expect.poll(async () => (await listRequests(alice.page, docId, "done")).map((r) => r.id)).toContain(request.id);
  });
});
