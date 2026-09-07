import { expect, test } from "./fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { AGENT_DOCS_URL } from "../src/lib/mcp";
import { createDocument, devLogin, mintToken, uniqueLogin, waitForEditor, waitForHydration } from "./helpers";

const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 393, height: 851 },
] as const;
const COPILOT_APP_DOCS = "https://github.com/burkeholland/markdoc/blob/main/docs/agents.md#inside-the-copilot-app";

test.use({ trace: "off", screenshot: "off", video: "off" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function blockNonLoopbackTraffic(context: BrowserContext) {
  await context.route(/^https?:\/\//, async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") await route.continue();
    else await route.abort();
  });
}

async function expectTarget(locator: Locator, label: string, minimum: { width?: number; height: number }) {
  await expect(locator, `${label} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has a box`).not.toBeNull();
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(minimum.height);
  if (minimum.width !== undefined) expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(minimum.width);
  return box!;
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  const value = { ...size, overflow: size.scrollWidth - size.clientWidth };
  expect(value.overflow, `${label}: page overflow-x`).toBe(0);
  return value;
}

async function expectLinkClick(page: Page, link: Locator, href: string) {
  await expect(link).toHaveAttribute("href", href);
  const pageCount = page.context().pages().length;
  const currentUrl = page.url();
  await link.evaluate((element) => {
    element.addEventListener(
      "click",
      (event) => {
        element.setAttribute("data-native-click", String(event.isTrusted));
        event.preventDefault();
      },
      { once: true },
    );
  });
  await link.click();
  await expect(link).toHaveAttribute("data-native-click", "true");
  await expect(link).toBeFocused();
  expect(page.context().pages().length, "documentation click opened no external page").toBe(pageCount);
  expect(page.url(), "documentation click kept the current page").toBe(currentUrl);
}

async function settleSwitch(toggle: Locator) {
  await toggle.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
}

type SwitchGeometry = {
  track: { x: number; y: number; width: number; height: number };
  thumb: { x: number; y: number; width: number; height: number; translateX: number; translateY: number };
  gaps: { left: number; right: number; top: number; bottom: number };
  checked: boolean;
  disabled: boolean;
};

const switchGeometry = (toggle: Locator): Promise<SwitchGeometry> =>
  toggle.evaluate((element) => {
    const number = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const round = (value: number) => Number(value.toFixed(3));
    const trackRect = element.getBoundingClientRect();
    const trackStyle = getComputedStyle(element);
    const thumbStyle = getComputedStyle(element, "::after");
    const transform = thumbStyle.transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(thumbStyle.transform);
    const thumbWidth = number(thumbStyle.width);
    const thumbHeight = number(thumbStyle.height);
    const thumbX = trackRect.x + number(trackStyle.borderLeftWidth) + number(thumbStyle.left) + transform.m41;
    const thumbY = trackRect.y + number(trackStyle.borderTopWidth) + number(thumbStyle.top) + transform.m42;
    return {
      track: { x: round(trackRect.x), y: round(trackRect.y), width: round(trackRect.width), height: round(trackRect.height) },
      thumb: {
        x: round(thumbX),
        y: round(thumbY),
        width: round(thumbWidth),
        height: round(thumbHeight),
        translateX: round(transform.m41),
        translateY: round(transform.m42),
      },
      gaps: {
        left: round(thumbX - trackRect.x),
        right: round(trackRect.right - thumbX - thumbWidth),
        top: round(thumbY - trackRect.y),
        bottom: round(trackRect.bottom - thumbY - thumbHeight),
      },
      checked: element.getAttribute("aria-checked") === "true",
      disabled: (element as HTMLButtonElement).disabled,
    };
  });

function expectWithin(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1);
}

function expectSwitchGeometry(value: SwitchGeometry, checked: boolean, disabled: boolean, label: string) {
  expect(value.track.width, `${label}: track width`).toBeGreaterThanOrEqual(44);
  expect(value.track.height, `${label}: track height`).toBeGreaterThanOrEqual(24);
  expectWithin(value.thumb.width, 16, `${label}: thumb width`);
  expectWithin(value.thumb.height, 16, `${label}: thumb height`);
  expectWithin(value.thumb.translateX, checked ? 22 : 0, `${label}: thumb translation`);
  expectWithin(checked ? value.gaps.right : value.gaps.left, 3, `${label}: outer horizontal gap`);
  expectWithin(value.gaps.top, value.gaps.bottom, `${label}: balanced vertical gaps`);
  expect(value.gaps.top, `${label}: top gap`).toBeGreaterThanOrEqual(3);
  expect(value.gaps.bottom, `${label}: bottom gap`).toBeGreaterThanOrEqual(3);
  expect(value.checked, `${label}: checked state`).toBe(checked);
  expect(value.disabled, `${label}: disabled state`).toBe(disabled);
}

async function openTokenDetails(page: Page) {
  const rows = page.getByTestId("token-row");
  await expect(rows).toHaveCount(1);
  const details = rows.locator("details");
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
  return rows.getByTestId("token-collaborators-may-ask");
}

for (const viewport of VIEWPORTS) {
  test(`[2814] settings and editor targets stay usable at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport });
    await blockNonLoopbackTraffic(context);
    const page = await context.newPage();
    let token: Awaited<ReturnType<typeof mintToken>> | undefined;

    try {
      await devLogin(page, uniqueLogin(`small-targets-${viewport.width}`));
      token = await mintToken(page, `Phone target ${viewport.width}`);
      await page.goto("/settings");
      await waitForHydration(page);

      let toggle = await openTokenDetails(page);
      await expectTarget(toggle, "token switch", { width: 44, height: 24 });
      await settleSwitch(toggle);
      const unchecked = await switchGeometry(toggle);
      expectSwitchGeometry(unchecked, false, false, "unchecked switch");

      const updateUrl = `**/api/tokens/${token.id}`;
      const successStarted = deferred();
      const releaseSuccess = deferred();
      let successPayload: unknown;
      await page.route(
        updateUrl,
        async (route) => {
          successPayload = route.request().postDataJSON();
          successStarted.resolve();
          await releaseSuccess.promise;
          await route.continue();
        },
        { times: 1 },
      );
      let disabledChecked: SwitchGeometry;
      try {
        await toggle.click();
        await successStarted.promise;
        expect(successPayload).toEqual({ collaboratorsMayAsk: true });
        await expect(toggle).toBeDisabled();
        await settleSwitch(toggle);
        disabledChecked = await switchGeometry(toggle);
        expectSwitchGeometry(disabledChecked, true, true, "checked disabled switch");
      } finally {
        releaseSuccess.resolve();
      }
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      await page.reload();
      await waitForHydration(page);
      toggle = await openTokenDetails(page);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await settleSwitch(toggle);
      const persistedChecked = await switchGeometry(toggle);
      expectSwitchGeometry(persistedChecked, true, false, "persisted checked switch");

      const failureStarted = deferred();
      const releaseFailure = deferred();
      let failurePayload: unknown;
      await page.route(
        updateUrl,
        async (route) => {
          failurePayload = route.request().postDataJSON();
          failureStarted.resolve();
          await releaseFailure.promise;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Synthetic local failure" }),
          });
        },
        { times: 1 },
      );
      let disabledUnchecked: SwitchGeometry;
      try {
        await toggle.click();
        await failureStarted.promise;
        expect(failurePayload).toEqual({ collaboratorsMayAsk: false });
        await expect(toggle).toBeDisabled();
        await settleSwitch(toggle);
        disabledUnchecked = await switchGeometry(toggle);
        expectSwitchGeometry(disabledUnchecked, false, true, "unchecked disabled switch");
      } finally {
        releaseFailure.resolve();
      }
      await expect(page.getByTestId("token-collaborators-may-ask-error")).toBeVisible();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await settleSwitch(toggle);
      const rollbackChecked = await switchGeometry(toggle);
      expectSwitchGeometry(rollbackChecked, true, false, "rollback checked switch");
      expectWithin(unchecked.gaps.left, persistedChecked.gaps.right, "balanced unchecked/checked outer gaps");

      await page.getByTestId("token-manager").getByRole("button", { name: "Connect an MCP client", exact: true }).click();
      await expect(page.getByTestId("token-manager").getByRole("button", { name: "Connect an MCP client", exact: true })).toHaveAttribute("aria-pressed", "true");
      const agentDocs = page.getByTestId("agent-docs-link");
      const agentDocsBox = await expectTarget(agentDocs, "agent setup documentation link", { height: 24 });
      await expectLinkClick(page, agentDocs, AGENT_DOCS_URL);

      await page.getByTestId("agent-connect-tab-copilot-app").click();
      const appDocs = page.getByRole("link", { name: "Inside the Copilot app setup and limits" });
      const appDocsBox = await expectTarget(appDocs, "Copilot app documentation link", { height: 24 });
      await expectLinkClick(page, appDocs, COPILOT_APP_DOCS);

      await page.getByTestId("webhook-add").click();
      const eventCheckboxes = page.locator('[data-testid^="webhook-event-"]');
      await expect(eventCheckboxes).toHaveCount(7);
      const webhookHeights: number[] = [];
      for (let index = 0; index < (await eventCheckboxes.count()); index++) {
        const checkbox = eventCheckboxes.nth(index);
        const label = checkbox.locator("..");
        const box = await expectTarget(label, `webhook event row ${index + 1}`, { height: 24 });
        webhookHeights.push(box.height);
        const before = await checkbox.isChecked();
        await label.click();
        await expect(checkbox).toBeChecked({ checked: !before });
        await label.click();
        await expect(checkbox).toBeChecked({ checked: before });
      }
      const settingsOverflow = await expectNoHorizontalOverflow(page, "settings");

      const docId = await createDocument(page, "# Phone targets\n\n```js\nconst answer = 42;\n```\n", "Phone targets");
      await page.goto(`/d/${docId}`);
      await waitForEditor(page);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect(page.locator(".md-rich")).toBeVisible();
      const language = page.getByRole("textbox", { name: "Code block language" });
      const languageBox = await expectTarget(language, "code language input", { height: 24 });
      expect(languageBox.width, "code language input keeps its compact width").toBeLessThanOrEqual(72);
      await language.click();
      await expect(language).toBeFocused();
      await language.fill("ts");
      await expect(language).toBeFocused();
      await language.press("Enter");
      await expect(page.locator(".md-rich pre")).toHaveAttribute("data-language", "ts");
      await expect(page.locator(".md-rich")).toBeFocused();

      await page.keyboard.press("Control+Shift+P");
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await page.getByTestId("palette-input").fill("keep agent");
      await page.getByTestId("palette-item-doc:keep-agent").click();
      await expect(page.getByTestId("keep-agent-dialog")).toBeVisible();
      const keepAgentDocs = page.getByTestId("keep-agent-docs-link");
      const keepAgentDocsBox = await expectTarget(keepAgentDocs, "keep-agent documentation link", { height: 24 });
      await expectLinkClick(page, keepAgentDocs, `${AGENT_DOCS_URL}#sit-in-a-document`);
      const editorOverflow = await expectNoHorizontalOverflow(page, "editor");
      console.log(
        `[2814] control geometry ${viewport.width}x${viewport.height} ${JSON.stringify({
          switch: { unchecked, disabledChecked, persistedChecked, disabledUnchecked, rollbackChecked },
          targets: {
            webhookHeights,
            documentationHeights: [agentDocsBox.height, appDocsBox.height, keepAgentDocsBox.height],
            language: { width: languageBox.width, height: languageBox.height },
          },
          overflow: { settings: settingsOverflow, editor: editorOverflow },
          actions: { togglePersisted: true, failedToggleRolledBack: true, webhookLabels: 7, documentationLinks: 3, languageCommitted: true },
        })}`,
      );
    } finally {
      await token?.revoke();
      await context.close();
    }
  });
}
