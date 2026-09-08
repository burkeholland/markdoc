import { test } from "./fixtures";
import type {
  BrowserContext,
  BrowserContextOptions,
  Page,
  TestInfo,
} from "@playwright/test";
import { createDocument, devLogin, uniqueLogin } from "./helpers";
import {
  MATRIX_AXES,
  MATRIX_ROWS,
  assertMatrixNetworkRoutingContract,
  completeMatrixTraffic,
  completeLateFont,
  completeLateImage,
  createMatrixNetworkFixture,
  createMatrixSummary,
  exerciseActions,
  finalizeMatrixSummary,
  installOwnershipProbe,
  openMatrixDocument,
  preventNonLoopbackTraffic,
  recordMatrixFailure,
  runLifecycleChecks,
  sampleEdgeReachability,
  sampleRetainedStates,
  setMatrixEnvironment,
  setupLateResources,
  type FontAsset,
  type MatrixNetworkFixture,
  type MatrixRow,
  type MatrixSummary,
  type MatrixTrafficState,
} from "./selection-bubble-matrix";

const SELECTED_TEXT =
  "The selected passage is deliberately long enough to wrap while image and font metrics finish naturally.";
const EDGE_TEXT = "Toolbar edge probe";
const ACTION_TEXT = "Toolbar action probe";
const LATE_IMAGE_ALT = "Delayed local geometry";
const FILLER = Array.from(
  { length: 72 },
  (_, index) =>
    `Synthetic paragraph ${index + 1} keeps every toolbar position inside a locally generated document.`,
);
const DOCUMENT_SOURCE = [
  "# Reachable toolbar geometry",
  ...FILLER.slice(0, 24),
  `![${LATE_IMAGE_ALT}](/__selection-toolbar-matrix/late-image.svg)`,
  SELECTED_TEXT,
  ...FILLER.slice(24, 36),
  EDGE_TEXT,
  ...FILLER.slice(36, 48),
  ACTION_TEXT,
  ...FILLER.slice(48),
  "",
].join("\n\n");

const MATRIX_ENABLE_ENV = "E2E_SELECTION_BUBBLE_MATRIX";
const MATRIX_PORT_ENV = "E2E_SELECTION_BUBBLE_PORT";
const MATRIX_CONTEXT_KINDS = ["setup", "row", "lifecycle"] as const;

type StoredSession = Awaited<ReturnType<BrowserContext["storageState"]>>;
type MatrixContextRequest =
  | { kind: "setup"; networkFixture: MatrixNetworkFixture }
  | {
      kind: "row";
      storageState: StoredSession;
      row: MatrixRow;
      networkFixture: MatrixNetworkFixture;
    }
  | {
      kind: "lifecycle";
      storageState: StoredSession;
      networkFixture: MatrixNetworkFixture;
    };

function matrixContextOptions(
  request: MatrixContextRequest,
): BrowserContextOptions {
  const networkIsolation = { serviceWorkers: "block" as const };
  if (request.kind === "setup") return networkIsolation;
  if (request.kind === "lifecycle") {
    return {
      ...networkIsolation,
      storageState: request.storageState,
      viewport: { width: 768, height: 1024 },
      reducedMotion: "reduce",
    };
  }
  return {
    ...networkIsolation,
    storageState: request.storageState,
    viewport: request.row.viewport,
    reducedMotion: request.row.motion,
    hasTouch: request.row.viewport.width <= 390,
  };
}

interface MatrixContextCreator<Context> {
  newContext(options?: BrowserContextOptions): Promise<Context>;
}

function createMatrixContext<Context>(
  browser: MatrixContextCreator<Context>,
  request: MatrixContextRequest,
): Promise<Context> {
  return browser.newContext(matrixContextOptions(request));
}

function assertMatrixContextFactoryPolicy() {
  const row = MATRIX_ROWS[0];
  if (!row) throw new Error("matrix-context-row-probe-missing");
  const storageState: StoredSession = { cookies: [], origins: [] };
  const networkFixture = createMatrixNetworkFixture(
    "selection-toolbar-matrix-static",
  );
  const requests: MatrixContextRequest[] = [
    { kind: "setup", networkFixture },
    { kind: "row", storageState, row, networkFixture },
    { kind: "lifecycle", storageState, networkFixture },
  ];
  const coveredKinds = new Set(requests.map((request) => request.kind));
  if (
    requests.length !== MATRIX_CONTEXT_KINDS.length ||
    MATRIX_CONTEXT_KINDS.some((kind) => !coveredKinds.has(kind))
  ) {
    throw new Error("matrix-context-factory-coverage");
  }
  const observedOptions: BrowserContextOptions[] = [];
  const browser: MatrixContextCreator<null> = {
    async newContext(options) {
      observedOptions.push(options ?? {});
      return null;
    },
  };
  for (const request of requests) void createMatrixContext(browser, request);
  if (observedOptions.length !== requests.length) {
    throw new Error("matrix-context-factory-call-count");
  }
  for (const [index, request] of requests.entries()) {
    if (observedOptions[index]?.serviceWorkers !== "block") {
      throw new Error(`matrix-context-service-workers-${request.kind}`);
    }
    if (
      request.networkFixture !== networkFixture ||
      request.networkFixture.expectedAvatarSubstitutions !== 1
    ) {
      throw new Error(`matrix-context-avatar-fixture-${request.kind}`);
    }
  }
}

interface ClosableContext {
  close(): Promise<void>;
}

async function withOwnedContext<
  Context extends ClosableContext,
  Result,
>(
  createContext: () => Promise<Context>,
  operateContext: (context: Context) => Promise<Result>,
): Promise<Result> {
  const context = await createContext();
  try {
    return await operateContext(context);
  } finally {
    await context.close();
  }
}

interface RowInitialization<Context, MatrixPage, Resources, Traffic> {
  installRouting(context: Context): Promise<Traffic>;
  openPage(context: Context): Promise<MatrixPage>;
  setupResources(page: MatrixPage): Promise<Resources>;
}

async function initializeRow<Context, MatrixPage, Resources, Traffic>(
  context: Context,
  initialization: RowInitialization<Context, MatrixPage, Resources, Traffic>,
) {
  const traffic = await initialization.installRouting(context);
  const page = await initialization.openPage(context);
  const resources = await initialization.setupResources(page);
  return { traffic, page, resources };
}

async function assertContextFailureCleanup() {
  const stages = ["routing", "page", "resource-setup"] as const;
  for (const failedStage of stages) {
    const calls: string[] = [];
    const closed: ClosableContext[] = [];
    const failure = new Error(`matrix-static-${failedStage}`);
    const context: ClosableContext = {
      async close() {
        closed.push(context);
      },
    };
    let observed: unknown;
    try {
      await withOwnedContext(
        async () => context,
        async (ownedContext) => {
          await initializeRow(ownedContext, {
            async installRouting(value) {
              calls.push("routing");
              if (value !== context) {
                throw new Error("matrix-routing-context-mismatch");
              }
              if (failedStage === "routing") throw failure;
              return { blocked: 0 };
            },
            async openPage(value) {
              calls.push("page");
              if (value !== context) {
                throw new Error("matrix-page-context-mismatch");
              }
              if (failedStage === "page") throw failure;
              return { context: value };
            },
            async setupResources(page) {
              calls.push("resource-setup");
              if (page.context !== context) {
                throw new Error("matrix-resource-context-mismatch");
              }
              if (failedStage === "resource-setup") throw failure;
              return {};
            },
          });
        },
      );
    } catch (error) {
      observed = error;
    }
    const expectedCalls = stages.slice(0, stages.indexOf(failedStage) + 1);
    if (
      observed !== failure ||
      calls.join("|") !== expectedCalls.join("|") ||
      closed.length !== 1 ||
      closed[0] !== context
    ) {
      throw new Error(`matrix-context-cleanup-contract-${failedStage}`);
    }
  }
}

assertMatrixContextFactoryPolicy();
assertMatrixNetworkRoutingContract();
await assertContextFailureCleanup();

// Fullscreen is intentionally not a browser axis: Markdoc has no reachable
// Fullscreen API control. Source-only fullscreenchange lifecycle evidence stays
// in selection-bubble.test.tsx ("coalesces all owned signals..." and
// "owns transformed-body and descendant fullscreen enter/replace/exit").
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(
  process.env[MATRIX_ENABLE_ENV] !== "1",
  `Set ${MATRIX_ENABLE_ENV}=1 with matching ${MATRIX_PORT_ENV} and E2E_PORT values for the scheduled non-fullscreen run`,
);

function assertDedicatedLoopbackPort(testInfo: TestInfo) {
  const dedicated = process.env[MATRIX_PORT_ENV];
  const shared = process.env.E2E_PORT;
  const baseURL = new URL(String(testInfo.project.use.baseURL));
  if (!dedicated || dedicated !== shared || baseURL.port !== dedicated) {
    throw new Error("dedicated-port-mismatch");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(baseURL.hostname)) {
    throw new Error("base-url-not-loopback");
  }
}

async function findLocalFontAsset(page: Page): Promise<FontAsset> {
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => /\.woff2?(?:\?|$)/i.test(entry.name)),
  );
  const fontURL = await page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .find((entry) => /\.woff2?(?:\?|$)/i.test(entry.name))!.name,
  );
  const fontHost = new URL(fontURL).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(fontHost)) {
    throw new Error("local-font-not-loopback");
  }
  const response = await page.request.get(fontURL);
  if (!response.ok()) throw new Error("local-font-unavailable");
  const contentType = response.headers()["content-type"];
  if (!contentType) throw new Error("local-font-content-type-missing");
  return {
    body: await response.body(),
    contentType,
  };
}

async function createAuthenticatedState(
  context: BrowserContext,
  login: string,
  networkFixture: MatrixNetworkFixture,
  summary: MatrixSummary,
): Promise<{
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
  font: FontAsset;
}> {
  const traffic = await preventNonLoopbackTraffic(context, networkFixture);
  const page = await context.newPage();
  try {
    await devLogin(page, login);
    const font = await findLocalFontAsset(page);
    return { storageState: await context.storageState(), font };
  } finally {
    completeMatrixTraffic(summary, traffic, "setup");
  }
}

async function deleteDocument(page: Page, documentId: string) {
  const response = await page.request.delete(`/api/documents/${documentId}`);
  if (!response.ok()) throw new Error("matrix-document-cleanup-failed");
}

async function runRow(
  browserContext: () => Promise<BrowserContext>,
  row: MatrixRow,
  font: FontAsset,
  networkFixture: MatrixNetworkFixture,
  summary: MatrixSummary,
) {
  await withOwnedContext(browserContext, async (context) => {
    let page: Page | null = null;
    let resources: Awaited<ReturnType<typeof setupLateResources>> | null = null;
    let traffic: MatrixTrafficState | null = null;
    let documentId: string | null = null;

    try {
      const initialized = await initializeRow(context, {
        installRouting: (ownedContext) =>
          preventNonLoopbackTraffic(ownedContext, networkFixture),
        openPage: (ownedContext) => ownedContext.newPage(),
        setupResources: (matrixPage) => setupLateResources(matrixPage, font),
      });
      traffic = initialized.traffic;
      page = initialized.page;
      resources = initialized.resources;
      documentId = await createDocument(
        page,
        DOCUMENT_SOURCE,
        `Toolbar matrix ${row.ordinal}`,
      );
      await openMatrixDocument(page, documentId, SELECTED_TEXT);
      await setMatrixEnvironment(page, row);
      await sampleRetainedStates(page, row, summary, SELECTED_TEXT);
      await sampleEdgeReachability(page, row, summary, EDGE_TEXT);
      await completeLateImage(
        page,
        row,
        summary,
        resources,
        SELECTED_TEXT,
        LATE_IMAGE_ALT,
      );
      await completeLateFont(
        page,
        row,
        summary,
        resources,
        SELECTED_TEXT,
      );
      await exerciseActions(page, row, summary, ACTION_TEXT);

      summary.rows.completed++;
    } finally {
      resources?.releaseAll();
      try {
        if (page && documentId) await deleteDocument(page, documentId);
      } finally {
        if (traffic) completeMatrixTraffic(summary, traffic, `row-${row.ordinal}`);
      }
    }
  });
}

test(
  "selection toolbar reachable 4x2x2x2x3 geometry matrix @selection-toolbar-non-fullscreen-geometry",
  async ({ browser }, testInfo) => {
    test.setTimeout(3 * 60 * 60 * 1000);
    const summary = createMatrixSummary(MATRIX_AXES, MATRIX_ROWS.length);
    const attempts = new Map<string, number>();
    const login = uniqueLogin("selection-toolbar-matrix");
    const networkFixture = createMatrixNetworkFixture(login);

    try {
      assertDedicatedLoopbackPort(testInfo);
      const { storageState, font } = await withOwnedContext(
        () =>
          createMatrixContext(browser, {
            kind: "setup",
            networkFixture,
          }),
        (context) =>
          createAuthenticatedState(
            context,
            login,
            networkFixture,
            summary,
          ),
      );

      for (const row of MATRIX_ROWS) {
        attempts.set(row.key, (attempts.get(row.key) ?? 0) + 1);
        summary.rows.attempted++;
        try {
          await runRow(
            () =>
              createMatrixContext(browser, {
                kind: "row",
                storageState,
                row,
                networkFixture,
              }),
            row,
            font,
            networkFixture,
            summary,
          );
        } catch (error) {
          recordMatrixFailure(summary, row.key, "row", error);
        }
      }

      await withOwnedContext(
        () =>
          createMatrixContext(browser, {
            kind: "lifecycle",
            storageState,
            networkFixture,
          }),
        async (lifecycleContext) => {
          const lifecycleDocuments: string[] = [];
          let page: Page | null = null;
          let traffic: MatrixTrafficState | null = null;
          try {
            traffic = await preventNonLoopbackTraffic(
              lifecycleContext,
              networkFixture,
            );
            page = await lifecycleContext.newPage();
            await installOwnershipProbe(page);
            const first = await createDocument(
              page,
              DOCUMENT_SOURCE,
              "Toolbar lifecycle first",
            );
            lifecycleDocuments.push(first);
            const replacement = await createDocument(
              page,
              DOCUMENT_SOURCE,
              "Toolbar lifecycle replacement",
            );
            lifecycleDocuments.push(replacement);
            await runLifecycleChecks(
              page,
              summary,
              first,
              replacement,
              SELECTED_TEXT,
            );
          } catch (error) {
            recordMatrixFailure(summary, "lifecycle", "teardown", error);
          } finally {
            if (page) {
              for (const documentId of lifecycleDocuments) {
                try {
                  await deleteDocument(page, documentId);
                } catch (error) {
                  recordMatrixFailure(
                    summary,
                    "lifecycle",
                    "document-cleanup",
                    error,
                  );
                }
              }
            }
            if (traffic) {
              try {
                completeMatrixTraffic(summary, traffic, "lifecycle");
              } catch (error) {
                recordMatrixFailure(
                  summary,
                  "lifecycle",
                  "network",
                  error,
                );
              }
            }
          }
        },
      );
    } catch (error) {
      recordMatrixFailure(summary, "setup", "bootstrap", error);
    }

    for (const row of MATRIX_ROWS) {
      const count = attempts.get(row.key) ?? 0;
      if (count === 0) summary.rows.missing++;
      else if (count > 1) summary.rows.duplicate += count - 1;
    }
    const report = finalizeMatrixSummary(summary);
    console.log(JSON.stringify(report));
    if (
      report.failureCount ||
      report.rows.missing ||
      report.rows.duplicate ||
      report.rows.attempted !== MATRIX_ROWS.length ||
      report.rows.completed !== MATRIX_ROWS.length ||
      report.overflow.hiddenOrClippedRows !== 0 ||
      report.network.contexts !== MATRIX_ROWS.length + 2 ||
      report.network.avatarSubstitutions !==
        report.network.expectedAvatarSubstitutions ||
      report.network.unexpectedRequests !== 0 ||
      report.network.routingErrors !== 0 ||
      report.coverage.fullscreenBrowserClaims !== 0
    ) {
      throw new Error("selection-toolbar-reachable-geometry-failed");
    }
  },
);
