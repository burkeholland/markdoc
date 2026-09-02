import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { AGENT_DOCS_URL } from "../src/lib/mcp";
import { createDocument, devLogin, mintToken, openDocument, uniqueLogin, waitForHydration } from "./helpers";

const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 393, height: 851 },
] as const;

async function expectTarget(locator: Locator, label: string, minimum: { width?: number; height: number }) {
  await expect(locator, `${label} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has a box`).not.toBeNull();
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(minimum.height);
  if (minimum.width !== undefined) expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(minimum.width);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(size.scrollWidth, `${label}: page scrollWidth`).toBeLessThanOrEqual(size.clientWidth);
}

async function expectLinkClick(link: Locator) {
  await link.evaluate((element) => {
    element.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        element.setAttribute("data-clicked", "true");
      },
      { once: true },
    );
  });
  await link.click();
  await expect(link).toHaveAttribute("data-clicked", "true");
}

for (const viewport of VIEWPORTS) {
  test(`settings and editor targets stay usable at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    let token: Awaited<ReturnType<typeof mintToken>> | undefined;

    try {
      await devLogin(page, uniqueLogin(`small-targets-${viewport.width}`));
      token = await mintToken(page, `Phone target ${viewport.width}`);
      await page.goto("/settings");
      await waitForHydration(page);

      const toggle = page.getByTestId("token-collaborators-may-ask");
      await expectTarget(toggle, "token switch", { width: 44, height: 24 });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      const agentDocs = page.getByTestId("agent-docs-link");
      await expectTarget(agentDocs, "agent setup documentation link", { height: 24 });
      await expect(agentDocs).toHaveAttribute("href", AGENT_DOCS_URL);
      await expectLinkClick(agentDocs);

      await page.getByTestId("agent-connect-tab-copilot-app").click();
      const appDocs = page.getByRole("link", { name: "Inside the Copilot app setup and limits" });
      await expectTarget(appDocs, "Copilot app documentation link", { height: 24 });
      await expectLinkClick(appDocs);

      await page.getByTestId("webhook-add").click();
      const eventCheckboxes = page.locator('[data-testid^="webhook-event-"]');
      await expect(eventCheckboxes).toHaveCount(7);
      for (let index = 0; index < (await eventCheckboxes.count()); index++) {
        await expectTarget(eventCheckboxes.nth(index).locator(".."), `webhook event row ${index + 1}`, { height: 24 });
      }
      const contentChanged = page.getByTestId("webhook-event-content.changed");
      await expect(contentChanged).not.toBeChecked();
      await contentChanged.locator("..").click();
      await expect(contentChanged).toBeChecked();
      await expectNoHorizontalOverflow(page, "settings");

      const docId = await createDocument(page, "# Phone targets\n\n```js\nconst answer = 42;\n```\n", "Phone targets");
      await openDocument(page, docId);
      const language = page.getByRole("textbox", { name: "Code block language" });
      await expectTarget(language, "code language input", { height: 24 });
      const languageBox = await language.boundingBox();
      expect(languageBox!.width, "code language input keeps its compact width").toBeLessThanOrEqual(72);
      await language.click();
      await expect(language).toBeFocused();
      await language.fill("ts");
      await expect(language).toBeFocused();
      await language.press("Enter");
      await expect(page.locator(".md-rich pre")).toHaveAttribute("data-language", "ts");
      await expect(page.locator(".md-rich")).toBeFocused();

      await page.getByTestId("presence").click();
      await page.getByTestId("keep-agent-here").click();
      const keepAgentDocs = page.getByTestId("keep-agent-docs-link");
      await expectTarget(keepAgentDocs, "keep-agent documentation link", { height: 24 });
      await expect(keepAgentDocs).toHaveAttribute("href", `${AGENT_DOCS_URL}#sit-in-a-document`);
      await expectLinkClick(keepAgentDocs);
      await expectNoHorizontalOverflow(page, "editor");
    } finally {
      await token?.revoke();
      await context.close();
    }
  });
}
