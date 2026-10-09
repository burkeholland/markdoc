import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { test } from "./fixtures";
import { createDocument, openDocument, signIn, waitForEditor } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const CONTENT = "# Introduction\n\nIntro paragraph.\n";

async function liveText(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/documents/${id}/content`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { content: string }).content;
}

async function holdCollaboration(page: Page) {
  let route: WebSocketRoute | null = null;
  let server: WebSocketRoute | null = null;
  let released = false;
  const queued: Array<string | Buffer> = [];
  let connected!: () => void;
  const opened = new Promise<void>((resolve) => {
    connected = resolve;
  });

  await page.routeWebSocket(/\/collab/, (socket) => {
    route = socket;
    server = socket.connectToServer();
    socket.onMessage((message) => server!.send(message));
    server.onMessage((message) => {
      if (released) socket.send(message);
      else queued.push(message);
    });
    connected();
  });

  return {
    opened,
    release: () => {
      released = true;
      for (const message of queued.splice(0)) route?.send(message);
    },
  };
}

async function holdInitialRichRender(page: Page) {
  await page.addInitScript(() => {
    const browser = window as typeof window & {
      __releaseInitialRichRender?: () => void;
    };
    const request = window.requestIdleCallback.bind(window);
    const cancel = window.cancelIdleCallback.bind(window);
    const held = new Map<number, { callback: IdleRequestCallback; options?: IdleRequestOptions }>();
    let nextId = 1_000_000;

    browser.__releaseInitialRichRender = () => {
      for (const { callback, options } of held.values()) request(callback, options);
      held.clear();
    };
    window.requestIdleCallback = (callback, options) => {
      if (options?.timeout !== 1000) return request(callback, options);
      const id = nextId++;
      held.set(id, { callback, options });
      return id;
    };
    window.cancelIdleCallback = (id) => {
      if (!held.delete(id)) cancel(id);
    };
  });
}

async function releaseInitialRichRender(page: Page) {
  await page.evaluate(() => {
    const browser = window as typeof window & {
      __releaseInitialRichRender?: () => void;
    };
    browser.__releaseInitialRichRender?.();
  });
}

test.describe("initial document readiness", () => {
  test("blocks earliest toolbar, slash, palette, shortcut, and typing mutations until the live pane represents the document", async ({ browser }) => {
    const user = await signIn(browser, "early-insert");
    try {
      const { page } = user;
      const id = await createDocument(page, CONTENT, "Early insert readiness");
      const gate = await holdCollaboration(page);

      await page.goto(`/d/${id}`);
      await waitForEditor(page);
      await gate.opened;

      const table = page.getByTestId("tb-table");
      await expect(page.getByTestId("rich-placeholder")).toBeVisible();
      await expect(table).toBeDisabled();
      await table.dispatchEvent("click");
      await expect(page.getByTestId("table-grid")).toHaveCount(0);

      const rich = page.locator(".md-rich");
      await expect(rich).toHaveAttribute("contenteditable", "false");
      await rich.evaluate((element: HTMLElement) => element.focus());
      await page.keyboard.type("EARLY/");
      await page.keyboard.press(`${mod}+Alt+1`);
      await expect(page.getByTestId("slash-menu")).toHaveCount(0);

      await page.locator("body").press(`${mod}+Shift+P`);
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await expect(page.getByTestId("palette-item-block:table")).toHaveCount(0);
      await page.keyboard.press("Escape");
      expect(await liveText(page, id)).toBe(CONTENT);

      gate.release();
      await expect(page.getByTestId("rich-placeholder")).toHaveCount(0);
      await expect(page.locator(".md-rich")).toContainText("Intro paragraph.");
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

      await page.locator(".md-rich p").last().click();
      await page.keyboard.press("End");
      await table.click();
      await page.getByTestId("table-grid").getByRole("button", { name: "2 by 2" }).click();
      await expect.poll(() => liveText(page, id)).toContain("| Column 1 | Column 2 |");
      const saved = await liveText(page, id);
      expect(saved).toContain(CONTENT.trimEnd());
      expect(saved.match(/\| Column 1 \| Column 2 \|/g)).toHaveLength(1);
      expect(saved).not.toContain("EARLY");
    } finally {
      await user.context.close();
    }
  });

  test("a second window cannot say saved or mutate while its live rich pane is still held", async ({ browser }) => {
    const user = await signIn(browser, "early-insert-second-window");
    try {
      const id = await createDocument(user.page, CONTENT, "Second-window readiness");
      await openDocument(user.page, id);

      const second = await user.context.newPage();
      await holdInitialRichRender(second);
      await second.goto(`/d/${id}`);
      await waitForEditor(second);

      await expect(second.getByTestId("rich-placeholder")).toBeVisible();
      await expect(second.getByTestId("save-state")).toHaveAttribute("data-state", "saving");
      await expect(second.getByTestId("tb-table")).toBeDisabled();
      await second.getByTestId("tb-table").dispatchEvent("click");
      await expect(second.getByTestId("table-grid")).toHaveCount(0);
      expect(await liveText(second, id)).toBe(CONTENT);

      await releaseInitialRichRender(second);
      await expect(second.getByTestId("rich-placeholder")).toHaveCount(0);
      await expect(second.locator(".md-rich")).toContainText("Intro paragraph.");
      await expect(second.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
      await second.close();
    } finally {
      await user.context.close();
    }
  });

  test("an empty document becomes editable after a fast authoritative sync", async ({ browser }) => {
    const user = await signIn(browser, "early-insert-empty");
    try {
      const id = await createDocument(user.page, "", "Empty readiness");
      await openDocument(user.page, id);
      await expect(user.page.getByTestId("tb-table")).toBeEnabled();
      await user.page.locator(".md-rich").click();
      await user.page.keyboard.type("Ready");
      await expect.poll(() => liveText(user.page, id)).toBe("Ready");
    } finally {
      await user.context.close();
    }
  });
});
