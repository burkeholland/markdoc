import type { BrowserContext } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createDocument, devLogin, openDocument, uniqueLogin } from "./helpers";

test.use({ trace: "off", screenshot: "off", video: "off" });

function isLoopbackUrl(url: string | URL) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

async function blockNonLoopbackTraffic(context: BrowserContext) {
  await context.route(/^https?:\/\//, async (route) => {
    if (isLoopbackUrl(route.request().url())) await route.continue();
    else await route.abort();
  });
  await context.routeWebSocket((url) => !isLoopbackUrl(url), (webSocket) => webSocket.close());
}

interface MoreMenuSelectionEvidence {
  nativeClick: {
    target: {
      relation: "item" | "item-descendant" | "other";
      nodeName: string | null;
      role: string | null;
      testId: string | null;
    };
    currentTarget: "body" | "document" | "item" | "window" | "null" | "other";
    phase: number;
    defaultPrevented: boolean;
    trusted: boolean;
    pathBoundary: {
      length: number;
      itemIndex: number;
      bodyIndex: number;
      documentIndex: number;
      windowIndex: number;
      documentIsPenultimate: boolean;
      windowIsLast: boolean;
    };
  };
  customSelection: {
    count: number;
    reachedWindowCapture: boolean;
    reachedItemTarget: boolean;
    windowCurrentTarget: "window" | "other";
    windowPhase: number;
    windowDefaultPrevented: boolean;
    itemCurrentTarget: "item" | "other" | null;
    itemPhase: number | null;
    itemDefaultPrevented: boolean | null;
  };
}

test("a trusted More-menu selection closes the menu and opens Version history", async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
  await blockNonLoopbackTraffic(context);
  const page = await context.newPage();
  try {
    await devLogin(page, uniqueLogin("more-menu-selection"));
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, "# Browser selection\n");
    await openDocument(page, id);

    await page.getByTestId("more-menu").click();
    const menu = page.getByRole("menu");
    const history = page.getByRole("menuitem", { name: "Version history" });
    await expect(history).toBeVisible();
    await expect(history).toBeEnabled();
    await page.evaluate(() => {
      const item = document.querySelector<HTMLElement>('[data-testid="menu-history"]');
      if (!item) throw new Error("Version history menu item is missing");

      type DiagnosticWindow = typeof window & {
        __moreMenuSelectionEvidence?: MoreMenuSelectionEvidence;
        __removeMoreMenuSelectionDiagnostic?: () => void;
      };
      const diagnosticWindow = window as DiagnosticWindow;
      let click: MouseEvent | null = null;
      let selection: Event | null = null;
      let count = 0;
      const classifyCurrentTarget = (
        currentTarget: EventTarget | null,
      ): MoreMenuSelectionEvidence["nativeClick"]["currentTarget"] => {
        if (currentTarget === null) return "null";
        if (currentTarget === document.body) return "body";
        if (currentTarget === document) return "document";
        if (currentTarget === item) return "item";
        if (currentTarget === window) return "window";
        return "other";
      };
      const onClick = (event: MouseEvent) => {
        click = event;
      };
      const onWindowSelect = (event: Event) => {
        if (event.target !== item || !click) return;
        count += 1;
        selection = event;
        const target = click.target;
        const targetElement = target instanceof Element ? target : null;
        const path = click.composedPath();
        const documentIndex = path.indexOf(document);
        diagnosticWindow.__moreMenuSelectionEvidence = {
          nativeClick: {
            target: {
              relation: target === item
                ? "item"
                : target instanceof Node && item.contains(target)
                  ? "item-descendant"
                  : "other",
              nodeName: target instanceof Node ? target.nodeName : null,
              role: targetElement?.getAttribute("role") ?? null,
              testId: targetElement?.getAttribute("data-testid") ?? null,
            },
            currentTarget: classifyCurrentTarget(click.currentTarget),
            phase: click.eventPhase,
            defaultPrevented: click.defaultPrevented,
            trusted: click.isTrusted,
            pathBoundary: {
              length: path.length,
              itemIndex: path.indexOf(item),
              bodyIndex: path.indexOf(document.body),
              documentIndex,
              windowIndex: path.indexOf(window),
              documentIsPenultimate: documentIndex === path.length - 2,
              windowIsLast: path[path.length - 1] === window,
            },
          },
          customSelection: {
            count,
            reachedWindowCapture: true,
            reachedItemTarget: false,
            windowCurrentTarget: event.currentTarget === window ? "window" : "other",
            windowPhase: event.eventPhase,
            windowDefaultPrevented: event.defaultPrevented,
            itemCurrentTarget: null,
            itemPhase: null,
            itemDefaultPrevented: null,
          },
        };
      };
      const onItemSelect = (event: Event) => {
        if (event !== selection) return;
        const evidence = diagnosticWindow.__moreMenuSelectionEvidence;
        if (!evidence) return;
        evidence.customSelection.reachedItemTarget = true;
        evidence.customSelection.itemCurrentTarget = event.currentTarget === item ? "item" : "other";
        evidence.customSelection.itemPhase = event.eventPhase;
        evidence.customSelection.itemDefaultPrevented = event.defaultPrevented;
      };
      item.addEventListener("click", onClick, { capture: true });
      window.addEventListener("menu.itemSelect", onWindowSelect, { capture: true });
      item.addEventListener("menu.itemSelect", onItemSelect, { capture: true });
      diagnosticWindow.__removeMoreMenuSelectionDiagnostic = () => {
        item.removeEventListener("click", onClick, { capture: true });
        window.removeEventListener("menu.itemSelect", onWindowSelect, { capture: true });
        item.removeEventListener("menu.itemSelect", onItemSelect, { capture: true });
        delete diagnosticWindow.__moreMenuSelectionEvidence;
        delete diagnosticWindow.__removeMoreMenuSelectionDiagnostic;
      };
    });

    await history.click();
    const evidence = await page.evaluate(() =>
      (window as typeof window & {
        __moreMenuSelectionEvidence?: MoreMenuSelectionEvidence;
      }).__moreMenuSelectionEvidence);
    console.log(`[More-menu selection diagnostic] ${JSON.stringify(evidence)}`);
    expect(evidence).toEqual(expect.objectContaining({
      nativeClick: expect.objectContaining({
        target: expect.objectContaining({
          relation: expect.stringMatching(/^(item|item-descendant)$/),
          nodeName: expect.any(String),
        }),
        currentTarget: expect.any(String),
        phase: expect.any(Number),
        defaultPrevented: expect.any(Boolean),
        trusted: true,
        pathBoundary: expect.objectContaining({
          length: expect.any(Number),
          itemIndex: expect.any(Number),
          bodyIndex: expect.any(Number),
          documentIndex: expect.any(Number),
          windowIndex: expect.any(Number),
          documentIsPenultimate: expect.any(Boolean),
          windowIsLast: expect.any(Boolean),
        }),
      }),
      customSelection: {
        count: 1,
        reachedWindowCapture: true,
        reachedItemTarget: true,
        windowCurrentTarget: "window",
        windowPhase: Event.CAPTURING_PHASE,
        windowDefaultPrevented: false,
        itemCurrentTarget: "item",
        itemPhase: Event.AT_TARGET,
        itemDefaultPrevented: false,
      },
    }));

    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("versions-panel")).toBeVisible();
    await expect(page.getByTestId("versions-panel")).toHaveCount(1);
  } finally {
    await page.evaluate(() => {
      const diagnosticWindow = window as typeof window & {
        __removeMoreMenuSelectionDiagnostic?: () => void;
      };
      diagnosticWindow.__removeMoreMenuSelectionDiagnostic?.();
    }).catch(() => undefined);
    await context.close();
  }
});
