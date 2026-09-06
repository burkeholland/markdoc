import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import type { ApiTokenDto } from "../src/lib/api";
import { createDocument, devLogin, openDocument, uniqueLogin, waitForEditor, waitForHydration } from "./helpers";

// Deliberately do not import ./fixtures or the root config: this suite has no server or diagnostic hooks.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off", video: "off", serviceWorkers: "block" });

const ORIGIN = process.env.PROD_BASE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:3414";
const configuredOrigin = new URL(ORIGIN);
if (configuredOrigin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(configuredOrigin.hostname)) {
  throw new Error("The synthetic token flow requires an explicit loopback HTTP origin");
}
const EXISTING = "Existing synthetic agent";
const RENAMED = "Renamed synthetic agent with a long name to exercise wrapping on small screens";
const DOCUMENT_AGENT = "Synthetic document agent";
const UNMATCHED = "Unavailable synthetic agent";

type Mutation = { method: string; path: string; body: unknown };

function expectLastMutation(mutations: Mutation[], expected: Mutation) {
  expect(isDeepStrictEqual(mutations.at(-1), expected)).toBe(true);
}

function mockTokenApi() {
  const state = {
    rows: [] as ApiTokenDto[],
    listCalls: 0,
    unexpectedCalls: 0,
    mutations: [] as Mutation[],
    failReplacement: false,
    secret: "",
    replacementId: "",
  };
  let serial = 0;
  const metadata = (id: string, name: string, overrides: Partial<ApiTokenDto> = {}): ApiTokenDto => ({
    id, name, prefix: "synthetic", scope: "comment", documentIds: null,
    collaboratorsMayAsk: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastUsedAt: "2025-02-01T00:00:00.000Z",
    lastMcpSeenAt: null, lastMcpCallAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null,
    ...overrides,
  });
  const seed = (documentId: string) => {
    state.rows = [
      metadata("synthetic-existing", EXISTING, { documentIds: [documentId], collaboratorsMayAsk: true }),
      metadata("synthetic-expired", "Expired synthetic agent", { scope: "read", expiresAt: "2000-01-01T00:00:00.000Z", lastUsedAt: null }),
      metadata("synthetic-revoked", "Revoked synthetic agent", { scope: "full", revokedAt: "2025-03-01T00:00:00.000Z" }),
    ];
  };
  const issue = (row: ApiTokenDto) => {
    // Only the routed browser response sees this value; never use it as an API credential.
    state.secret = `mdk_${randomBytes(32).toString("hex")}`;
    return { token: { ...row, token: state.secret } };
  };
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "GET" && url.pathname === "/api/tokens") {
      const includeRevoked = url.searchParams.get("includeRevoked") === "true";
      if (includeRevoked) state.listCalls++;
      await route.fulfill({
        json: { tokens: includeRevoked ? state.rows : state.rows.filter((row) => !row.revokedAt) },
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    const body = request.postData() ? request.postDataJSON() : null;
    state.mutations.push({ method, path: url.pathname, body });
    if (method === "POST" && url.pathname === "/api/tokens") {
      if (body.name === UNMATCHED || state.rows.some((row) => !row.revokedAt && row.name === body.name)) {
        await route.fulfill({ status: 409, json: { error: "An existing token reserves that name." } });
        return;
      }
      const row = metadata(`synthetic-created-${++serial}`, body.name, {
        scope: body.scope, documentIds: body.documentIds, lastUsedAt: null,
        createdAt: new Date().toISOString(),
      });
      state.rows.push(row);
      await route.fulfill({ status: 201, json: issue(row), headers: { "Cache-Control": "no-store" } });
      return;
    }
    const match = /^\/api\/tokens\/([^/]+)(\/replace)?$/.exec(url.pathname);
    const row = state.rows.find((item) => item.id === match?.[1]);
    if (row && method === "PATCH" && !match?.[2]) {
      row.name = body.name;
      await route.fulfill({ json: { token: row } });
      return;
    }
    if (row && method === "POST" && match?.[2]) {
      if (state.failReplacement) {
        state.failReplacement = false;
        await route.fulfill({ status: 503, json: { error: "Synthetic replacement failure; existing token unchanged." } });
        return;
      }
      row.revokedAt = new Date().toISOString();
      const replacement = { ...row, id: `synthetic-replaced-${++serial}`, revokedAt: null, lastUsedAt: null, createdAt: new Date().toISOString() };
      state.replacementId = replacement.id;
      state.rows.push(replacement);
      await route.fulfill({ status: 201, json: issue(replacement), headers: { "Cache-Control": "no-store" } });
      return;
    }
    if (row && method === "DELETE" && !match?.[2]) {
      row.revokedAt = new Date().toISOString();
      await route.fulfill({ json: { ok: true } });
      return;
    }
    state.unexpectedCalls++;
    await route.abort("blockedbyclient");
  };
  return { state, seed, handle };
}

async function installLocalGuards(page: Page, handleToken: (route: Route) => Promise<void>) {
  const context = page.context();
  // The context rule covers popups too; only this page's token mock may answer token requests.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN || /^\/api\/tokens(?:\/|$)/.test(url.pathname)) {
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      await route.abort("blockedbyclient");
    } else if (/^\/api\/tokens(?:\/|$)/.test(url.pathname)) {
      await handleToken(route);
    } else {
      await route.fallback();
    }
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.protocol === "ws:" && url.hostname === configuredOrigin.hostname && url.port === configuredOrigin.port) {
      socket.connectToServer();
    } else {
      socket.close();
    }
  });
  await context.addInitScript(() => {
    let text = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => { text = value; },
        readText: async () => text,
      },
    });
    document.execCommand = () => false;
  });
}

function tokenRow(page: Page, name: string, status: "Active" | "Expired" | "Revoked") {
  return page.getByTestId("token-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByText(status, { exact: true }) });
}

async function confirmAction(page: Page, action: Locator, accept: boolean) {
  const pendingDialog = page.waitForEvent("dialog");
  const clicked = action.click();
  const dialog = await pendingDialog;
  const isConfirm = dialog.type() === "confirm";
  const describesImpact = /old token stops working|stop working immediately/.test(dialog.message());
  if (accept) await dialog.accept();
  else await dialog.dismiss();
  await clicked;
  expect(isConfirm).toBe(true);
  expect(describesImpact).toBe(true);
}

async function expectSecret(page: Page, secret: string | (() => string)) {
  await expect.poll(async () => {
    const expected = typeof secret === "function" ? secret() : secret;
    return expected.length > 0 && (await page.getByTestId("copy-token").textContent()) === expected;
  }).toBe(true);
}

async function expectNoSecret(page: Page, secret: string) {
  await expect.poll(() => page.getByTestId("copy-token").count()).toBe(0);
  expect(await page.evaluate((value) => document.documentElement.textContent?.includes(value) ?? false, secret)).toBe(false);
  expect(await page.evaluate((value) => [localStorage, sessionStorage].some((storage) =>
    Object.keys(storage).some((key) => storage.getItem(key)?.includes(value))), secret)).toBe(false);
}

async function copySecret(page: Page, secret: string) {
  await page.getByTestId("copy-token-button").click();
  await expect(page.getByTestId("copy-token-button")).toHaveText("Copied");
  expect((await page.evaluate(() => navigator.clipboard.readText())) === secret).toBe(true);
}

async function expectCopyBelow(block: Locator, button: Locator) {
  const content = await block.boundingBox();
  const action = await button.boundingBox();
  expect(content !== null && action !== null).toBe(true);
  expect(action!.y).toBeGreaterThanOrEqual(content!.y + content!.height - 1);
}

async function expectKeepAgentLinks(page: Page, documentId: string) {
  const navigation = page.getByTestId("keep-agent-panel").getByRole("navigation", { name: "Agent setup" });
  const tokens = navigation.getByRole("link", { name: "Tokens", exact: true });
  const connect = navigation.getByRole("link", { name: "Connect an MCP client", exact: true });
  await expect(tokens).toBeVisible();
  await expect(connect).toBeVisible();
  const settings = `/settings?next=${encodeURIComponent(`/d/${documentId}`)}`;
  await expect(tokens).toHaveAttribute("href", `${settings}#tokens`);
  await expect(connect).toHaveAttribute("href", `${settings}#connect`);
  return { tokens, connect };
}

async function expectConfig(page: Page, shape: "mcpServers" | "servers") {
  // Parse inside a boolean check: a regression must not print a secret-bearing config.
  await expect.poll(async () => {
    try {
      const parsed = JSON.parse(await page.getByTestId("agent-connect-config").innerText());
      const server = parsed[shape]?.markdoc;
      return Object.keys(parsed).length === 1 && server?.type === "http" &&
        server?.url === `${ORIGIN}/api/mcp` &&
        server?.headers?.Authorization === ["Bearer", "MARKDOC_TOKEN"].join(" ") &&
        (shape === "servers" ? !("tools" in server) : JSON.stringify(server.tools) === '["*"]');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return false;
    }
  }).toBe(true);
  const copy = page.getByRole("button", { name: "Copy MCP configuration", exact: true });
  await expectCopyBelow(page.getByTestId("agent-connect-config"), copy);
  await copy.click();
  expect((await page.evaluate(() => navigator.clipboard.readText())) === (await page.getByTestId("agent-connect-config").innerText()).trim()).toBe(true);
}

async function expectLayout(page: Page, surface: Locator) {
  const sizes = await surface.evaluate((element) => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    client: element.clientWidth,
    scroll: element.scrollWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
  }));
  expect(sizes.viewport).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
  expect(sizes.left).toBeGreaterThanOrEqual(-1);
  expect(sizes.right).toBeLessThanOrEqual(sizes.viewport + 1);

  for (const block of await surface.locator('pre:visible, [data-testid="copy-token"]:visible, [data-testid="token-row"]:visible').all()) {
    const widths = await block.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  }
  const controls = surface.locator("button:visible, input:visible, select:visible, summary:visible, a:visible");
  expect(await controls.count()).toBeGreaterThan(0);
  for (const control of await controls.all()) {
    await control.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    const geometry = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      let left = 0;
      let right = document.documentElement.clientWidth;
      let top = 0;
      let bottom = window.innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left + parent.clientLeft);
          right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top + parent.clientTop);
          bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
        }
      }
      const hitRect = Array.from(element.getClientRects()).find((part) => part.width > 0 && part.height > 0) ?? rect;
      const hit = document.elementFromPoint(hitRect.left + hitRect.width / 2, hitRect.top + hitRect.height / 2);
      const disabled = element.matches(":disabled");
      return {
        inside: rect.width > 0 && rect.height > 0 && rect.left >= left - 1 && rect.right <= right + 1 &&
          rect.top >= top - 1 && rect.bottom <= bottom + 1,
        unobscured: disabled || hit === element || (hit !== null && element.contains(hit)),
        labelFits: element.tagName !== "BUTTON" ||
          (element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1),
      };
    });
    if (!geometry.inside || !geometry.unobscured || !geometry.labelFits) {
      console.log("[token-layout]", JSON.stringify({
        control: await control.getAttribute("data-testid") ?? await control.evaluate((element) => element.tagName),
        ...geometry,
      }));
    }
    expect(geometry).toEqual({ inside: true, unobscured: true, labelFits: true });
  }
}

for (const width of [390, 768, 1280]) {
  test(`synthetic token management, Share and Settings at ${width} CSS px`, async ({ page, baseURL }, testInfo) => {
    // Reject other configs before login, document creation, navigation or any token call.
    expect(baseURL === ORIGIN).toBe(true);
    expect(testInfo.project.use.trace === "off" && testInfo.project.use.screenshot === "off" && testInfo.project.use.video === "off").toBe(true);
    const mock = mockTokenApi();
    await installLocalGuards(page, mock.handle);
    await page.setViewportSize({ width, height: 900 });
    await devLogin(page, uniqueLogin(`synthetic-tokens-${width}`));
    expect(new URL(page.url()).origin === ORIGIN).toBe(true);
    const documentId = await createDocument(page, "# Synthetic token fixture\n\nDisposable local content only.\n", "Synthetic token fixture");
    // openDocument expects both editor panes; open at desktop width, then measure the requested layout.
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDocument(page, documentId);
    await page.setViewportSize({ width, height: 900 });

    const openKeepAgent = async () => {
      if (width < 768) {
        await page.getByTestId("more-menu").click();
        await page.getByTestId("menu-command-palette").click();
        await page.getByTestId("palette-input").fill("Keep an agent here");
      } else {
        await page.getByTestId("presence").click();
      }
      const [listed] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === "GET" && url.pathname === "/api/tokens" && url.search === "";
        }),
        (width < 768
          ? page.getByTestId("palette-item-doc:keep-agent")
          : page.getByTestId("presence-popover").getByTestId("keep-agent-here")).click(),
      ]);
      expect(listed.status()).toBe(200);
      await expect(page.getByTestId("keep-agent-dialog")).toBeVisible();
    };
    await openKeepAgent();
    await expect(page.getByTestId("agent-connect-card")).toBeVisible();
    await expectKeepAgentLinks(page, documentId);
    await page.getByTestId("agent-connect-dismiss").click();
    await expect(page.getByTestId("agent-connect-card")).toHaveCount(0);
    const dismissedLinks = await expectKeepAgentLinks(page, documentId);
    await expectLayout(page, page.getByRole("dialog", { name: "Keep an agent here", exact: true }));
    await dismissedLinks.tokens.click();
    await waitForHydration(page);
    await expect(page.getByRole("button", { name: "Tokens", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("token-manager")).toContainText("No tokens yet.");
    await expect(page.getByTestId("settings-back-to-document")).toHaveAttribute("href", `/d/${documentId}`);
    await page.getByTestId("settings-back-to-document").click();
    await waitForEditor(page);
    await openKeepAgent();
    await expect(page.getByTestId("agent-connect-card")).toHaveCount(0);
    await expectKeepAgentLinks(page, documentId);
    await page.keyboard.press("Escape");

    mock.seed(documentId);
    await page.evaluate(() => localStorage.removeItem("markdoc:agent-connect-dismissed"));
    await openKeepAgent();
    await expect(page.getByTestId("agent-connect-card")).toHaveCount(0);
    const existingLinks = await expectKeepAgentLinks(page, documentId);
    await expectLayout(page, page.getByRole("dialog", { name: "Keep an agent here", exact: true }));
    await existingLinks.connect.click();
    await waitForHydration(page);
    await expect(page.getByRole("button", { name: "Connect an MCP client", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("token-row")).toHaveCount(3);
    await page.getByTestId("settings-back-to-document").click();
    await waitForEditor(page);

    const share = page.getByTestId(width < 768 ? "more-menu" : "share-button");
    await share.click();
    if (width < 768) await page.getByTestId("menu-share").click();
    const dialog = page.getByRole("dialog", { name: /Share/ });
    const toggle = page.getByTestId("share-agent-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("token-manager")).toHaveCount(0);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const manager = page.getByTestId("token-manager");
    const navigation = manager.getByRole("navigation", { name: "Token access" });
    const tokens = navigation.getByRole("button", { name: "Tokens", exact: true });
    const connect = navigation.getByRole("button", { name: "Connect an MCP client", exact: true });
    const close = manager.getByRole("button", { name: "Close token management", exact: true });
    await expect(navigation.getByRole("button")).toHaveCount(2);
    await expect(navigation.getByRole("button", { name: "Close token management", exact: true })).toHaveCount(0);
    await expect(close).toBeVisible();
    await expect(tokens).toHaveAttribute("aria-pressed", "true");
    await expect(connect).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("token-name")).toHaveCount(0);
    await expect(page.getByTestId("token-row")).toHaveCount(3);
    const existing = tokenRow(page, EXISTING, "Active");
    await expect(existing.getByTestId("token-scope-chip")).toHaveText("comment");
    await expect(existing.getByTestId("token-documents-count")).toHaveText("1 document");
    await expect(existing).toContainText("Created");
    await expect(existing).toContainText("used");
    const expired = tokenRow(page, "Expired synthetic agent", "Expired");
    await expect(expired).toContainText("no recorded use");
    await expect(expired.getByRole("button", { name: "Replace Expired synthetic agent", exact: true })).toBeDisabled();
    await expect(tokenRow(page, "Revoked synthetic agent", "Revoked").getByRole("button")).toHaveCount(0);
    await expectLayout(page, dialog);

    await page.getByTestId("token-add").click();
    await expect(page.getByTestId("token-scope-comment")).toBeChecked();
    await expect(page.getByTestId("token-restrict")).toBeChecked();
    await page.getByTestId("token-name").fill(DOCUMENT_AGENT);
    await expectLayout(page, dialog);
    await page.getByTestId("token-create").click();
    await expectSecret(page, () => mock.state.secret);
    expectLastMutation(mock.state.mutations, {
      method: "POST", path: "/api/tokens",
      body: { name: DOCUMENT_AGENT, expiresInDays: 90, scope: "comment", documentIds: [documentId] },
    });
    const firstSecret = mock.state.secret;
    expect(await page.evaluate(async () => (await navigator.clipboard.readText()) === "")).toBe(true);
    await copySecret(page, firstSecret);
    await expect(page.getByTestId("token-add")).toBeDisabled();
    await expect(page.getByTestId("token-create")).toBeDisabled();
    await expectLayout(page, dialog);
    await connect.click();
    await expect(connect).toHaveAttribute("aria-pressed", "true");
    await expect(tokens).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("token-row")).toHaveCount(4);
    await expect(tokenRow(page, DOCUMENT_AGENT, "Active")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Copilot CLI", exact: true })).toHaveAttribute("aria-selected", "true");
    await expectConfig(page, "mcpServers");
    await expectSecret(page, firstSecret);
    const permissions = page.getByText("Optional Copilot CLI permissions", { exact: true });
    await expect(permissions).toBeVisible();
    await expect(page.getByTestId("agent-connect-permissions")).toBeHidden();
    await permissions.click();
    await expect(page.getByTestId("agent-connect-scope-chip")).toHaveText("comment");
    await expect(page.getByTestId("agent-connect-allow-line")).toHaveText(
      "copilot --allow-tool 'markdoc(markdoc_suggest),markdoc(markdoc_comment),markdoc(markdoc_presence)'",
    );
    const allowCopy = page.getByTestId("agent-connect-allow-copy");
    await expectCopyBelow(page.getByTestId("agent-connect-allow-line"), allowCopy);
    await allowCopy.click();
    expect((await page.evaluate(() => navigator.clipboard.readText())) === (await page.getByTestId("agent-connect-allow-line").innerText()).trim()).toBe(true);
    await expectLayout(page, dialog);
    await page.getByRole("button", { name: "I stored it - hide secret", exact: true }).click();
    await expect(tokens).toBeFocused();
    await expectNoSecret(page, firstSecret);
    await expect(page.getByTestId("agent-connect-scope-chip")).toHaveCount(0);
    await expect(page.getByTestId("agent-connect-permissions")).toBeVisible();
    await expectConfig(page, "mcpServers");
    await tokens.click();
    await toggle.click();
    await expect(manager).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.press("Enter");
    await expect(page.getByTestId("token-name")).toHaveCount(0);
    await expect(tokenRow(page, DOCUMENT_AGENT, "Active")).toHaveCount(1);
    await expectNoSecret(page, firstSecret);

    // Rename changes metadata only, including when the inline edit is cancelled.
    const beforeRename = mock.state.mutations.length;
    await existing.getByRole("button", { name: `Rename ${EXISTING}`, exact: true }).click();
    await expect(existing.getByLabel("Token name", { exact: true })).toBeFocused();
    await existing.getByLabel("Token name", { exact: true }).fill("Cancelled synthetic name");
    await existing.getByRole("button", { name: "Cancel rename", exact: true }).click();
    await expect(existing.getByRole("button", { name: `Rename ${EXISTING}`, exact: true })).toBeFocused();
    expect(mock.state.mutations.length).toBe(beforeRename);
    await existing.getByRole("button", { name: `Rename ${EXISTING}`, exact: true }).click();
    await existing.getByLabel("Token name", { exact: true }).fill(RENAMED);
    await expectLayout(page, dialog);
    await existing.getByRole("button", { name: "Save name", exact: true }).click();
    const renamed = tokenRow(page, RENAMED, "Active");
    await expect(renamed.getByRole("button", { name: `Rename ${RENAMED}`, exact: true })).toBeFocused();
    expectLastMutation(mock.state.mutations, { method: "PATCH", path: "/api/tokens/synthetic-existing", body: { name: RENAMED } });
    await expectNoSecret(page, firstSecret);
    await expect(renamed.getByTestId("token-scope-chip")).toHaveText("comment");
    await expect(renamed.getByTestId("token-documents-count")).toHaveText("1 document");

    const beforeReplace = mock.state.mutations.length;
    await confirmAction(page, renamed.getByRole("button", { name: `Replace ${RENAMED}`, exact: true }), false);
    expect(mock.state.mutations.length).toBe(beforeReplace);
    await expect(renamed).toBeVisible();
    mock.state.failReplacement = true;
    await confirmAction(page, renamed.getByRole("button", { name: `Replace ${RENAMED}`, exact: true }), true);
    await expect(manager.getByRole("alert")).toHaveText("Synthetic replacement failure; existing token unchanged.");
    await expect(page.getByTestId("token-row")).toHaveCount(4);
    await expect(renamed.getByRole("button", { name: `Replace ${RENAMED}`, exact: true })).toBeEnabled();
    await expectNoSecret(page, firstSecret);
    await confirmAction(page, renamed.getByRole("button", { name: `Replace ${RENAMED}`, exact: true }), true);
    await expectSecret(page, () => mock.state.secret);
    const replacementSecret = mock.state.secret;
    expect(replacementSecret !== firstSecret).toBe(true);
    expectLastMutation(mock.state.mutations, { method: "POST", path: "/api/tokens/synthetic-existing/replace", body: { confirm: true } });
    await expect(tokenRow(page, RENAMED, "Revoked")).toHaveCount(1);
    await expect(tokenRow(page, RENAMED, "Active")).toHaveCount(1);
    await expect(tokens).toBeFocused();
    const oldRow = mock.state.rows.find((row) => row.id === "synthetic-existing")!;
    const replacement = mock.state.rows.find((row) => row.id === mock.state.replacementId)!;
    expect([replacement.scope, replacement.documentIds, replacement.expiresAt, replacement.collaboratorsMayAsk])
      .toEqual([oldRow.scope, oldRow.documentIds, oldRow.expiresAt, oldRow.collaboratorsMayAsk]);
    await copySecret(page, replacementSecret);
    await expectLayout(page, dialog);

    // Close with a secret visible; reopen fetches metadata and cannot resurrect it.
    await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(tokens).toBeInViewport({ ratio: 1 });
    await expect(connect).toBeInViewport({ ratio: 1 });
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(share).toBeFocused();
    await expectNoSecret(page, replacementSecret);
    const beforeReopen = mock.state.listCalls;
    await share.press("Enter");
    if (width < 768) await page.getByTestId("menu-share").click();
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect.poll(() => mock.state.listCalls > beforeReopen).toBe(true);
    await expect(tokenRow(page, RENAMED, "Active")).toHaveCount(1);
    await expectNoSecret(page, replacementSecret);
    const beforeRevoke = mock.state.mutations.length;
    await confirmAction(page, renamed.getByRole("button", { name: `Revoke ${RENAMED}`, exact: true }), false);
    expect(mock.state.mutations.length).toBe(beforeRevoke);
    await expect(renamed).toHaveCount(1);
    await confirmAction(page, renamed.getByRole("button", { name: `Revoke ${RENAMED}`, exact: true }), true);
    await expect(tokenRow(page, RENAMED, "Revoked")).toHaveCount(2);
    await expect(renamed).toHaveCount(0);
    expectLastMutation(mock.state.mutations, { method: "DELETE", path: `/api/tokens/${mock.state.replacementId}`, body: null });
    await expect(tokens).toBeFocused();

    await connect.click();
    await expect(page.getByTestId("token-row")).toHaveCount(5);
    await expect(page.getByTestId("agent-connect-config-stdio")).toBeHidden();
    await expect(permissions).toBeVisible();
    await expect(page.getByTestId("agent-connect-permissions")).toBeHidden();
    await expect(page.getByTestId("agent-connect-scope-chip")).toHaveCount(0);
    await expectConfig(page, "mcpServers");
    await expectLayout(page, dialog);
    await page.getByTestId("agent-connect-tab-mcp-clients").click();
    await expect(page.getByRole("tab", { name: "VS Code", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(permissions).toHaveCount(0);
    await expect(page.getByTestId("agent-connect-permissions")).toHaveCount(0);
    await expectConfig(page, "servers");
    await expectLayout(page, dialog);
    await page.getByRole("tab", { name: "Other MCP clients", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Other MCP clients", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(permissions).toHaveCount(0);
    await expect(page.getByTestId("agent-connect-permissions")).toHaveCount(0);
    await expectConfig(page, "mcpServers");
    await page.getByTestId("agent-connect-stdio-toggle").click();
    const stdio = page.getByTestId("agent-connect-config-stdio");
    const copyStdio = page.getByRole("button", { name: "Copy stdio MCP configuration", exact: true });
    for (const [client, root] of [["Other MCP clients", "mcpServers"], ["VS Code", "servers"], ["Copilot CLI", "mcpServers"]]) {
      await page.getByRole("tab", { name: client, exact: true }).click();
      await expect(stdio).toBeVisible();
      await expect.poll(async () => {
        try {
          const parsed = JSON.parse(await stdio.innerText());
          const server = parsed[root]?.markdoc;
          return Object.keys(parsed).length === 1 && server?.command === "node" &&
            JSON.stringify(server?.args) === JSON.stringify(["/path/to/markdoc/mcp/server.mjs"]) &&
            server?.env?.MARKDOC_URL === ORIGIN && server?.env?.MARKDOC_TOKEN === "MARKDOC_TOKEN";
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return false;
        }
      }).toBe(true);
      await expectCopyBelow(stdio, copyStdio);
      await copyStdio.click();
      expect((await page.evaluate(() => navigator.clipboard.readText())) === (await stdio.innerText()).trim()).toBe(true);
      await expectLayout(page, dialog);
    }
    await page.getByTestId("agent-connect-stdio-toggle").click();
    await expect(stdio).toBeHidden();
    await page.getByRole("tab", { name: "Copilot app", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Copilot app", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(permissions).toHaveCount(0);
    await expect(page.getByTestId("agent-connect-permissions")).toHaveCount(0);
    await expect(page.getByTestId("agent-connect-copilot-app")).toBeVisible();
    await expect(page.getByTestId("agent-connect-config")).toHaveCount(0);
    const copyInstall = page.getByRole("button", { name: "Copy Copilot app install command", exact: true });
    await expectCopyBelow(page.getByTestId("agent-connect-app-install"), copyInstall);
    await copyInstall.click();
    expect((await page.evaluate(() => navigator.clipboard.readText())) === (await page.getByTestId("agent-connect-app-install").innerText()).trim()).toBe(true);
    await expectLayout(page, dialog);
    await page.keyboard.press("Escape");
    await expect(share).toBeFocused();

    await page.goto("/settings#tokens");
    await waitForHydration(page);
    await expect(tokens).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("token-name")).toHaveCount(0);
    await expect(page.getByTestId("token-row")).toHaveCount(5);
    await expectLayout(page, manager);
    await page.getByTestId("token-add").click();
    await expect(page.getByTestId("token-restrict")).not.toBeChecked();
    await expect(page.getByTestId("token-scope-comment")).toBeChecked();
    await page.getByTestId("token-name").fill("Synthetic settings reader");
    await page.getByTestId("token-scope-read").check();
    await page.getByTestId("token-restrict").check();
    await expect(page.getByTestId("token-create")).toBeDisabled();
    await expect(page.getByTestId("token-document-error")).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("token-document-error")).toHaveText("Select at least one document when restricting a token.");
    await page.getByTestId(`token-document-${documentId}`).check();
    await expectLayout(page, manager);
    await page.getByTestId("token-create").click();
    await expectSecret(page, () => mock.state.secret);
    const settingsSecret = mock.state.secret;
    expectLastMutation(mock.state.mutations, {
      method: "POST", path: "/api/tokens",
      body: { name: "Synthetic settings reader", expiresInDays: 90, scope: "read", documentIds: [documentId] },
    });
    await copySecret(page, settingsSecret);
    await expectLayout(page, manager);
    await page.getByRole("button", { name: "I stored it - hide secret", exact: true }).click();
    await expectNoSecret(page, settingsSecret);

    const beforeConflict = mock.state.listCalls;
    await page.getByTestId("token-name").fill(DOCUMENT_AGENT);
    await page.getByTestId("token-create").click();
    await expect(page.getByTestId("token-conflict")).toContainText("The matching token");
    await expect(tokenRow(page, DOCUMENT_AGENT, "Active")).toHaveAttribute("data-token-match", "true");
    await expect(tokenRow(page, DOCUMENT_AGENT, "Active")).toBeFocused();
    expect(mock.state.listCalls > beforeConflict).toBe(true);
    await expectNoSecret(page, settingsSecret);
    await page.getByTestId("token-name").fill(UNMATCHED);
    await page.getByTestId("token-create").click();
    await expect(page.getByTestId("token-conflict")).toContainText("could not be matched to this list");
    await expect(page.locator('[data-token-match="true"]')).toHaveCount(0);
    const beforeRefresh = mock.state.listCalls;
    await page.getByRole("button", { name: "Refresh token list", exact: true }).click();
    await expect.poll(() => mock.state.listCalls > beforeRefresh).toBe(true);
    await expectLayout(page, manager);
    await connect.click();
    await expect(page.getByTestId("token-row")).toHaveCount(6);
    await expect(tokenRow(page, "Synthetic settings reader", "Active")).toBeVisible();
    await expectConfig(page, "mcpServers");
    await expectLayout(page, manager);
    expect(mock.state.listCalls).toBeGreaterThanOrEqual(10);
    expect(mock.state.unexpectedCalls).toBe(0);
  });
}
