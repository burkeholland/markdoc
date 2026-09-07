import type {
  BrowserContext,
  Locator,
  Page,
  Route,
} from "@playwright/test";
import { codeText, selectTextInRich, waitForEditor } from "./helpers";

const RICH_SCROLLER = '[data-testid="rich-column"] .overflow-y-auto';
const ACTION_LABELS = [
  "Bold",
  "Italic",
  "Strikethrough",
  "Inline code",
  "Link",
  "Comment",
] as const;
const FRAME_MINIMUM = 20;
const FAILURE_COORDINATE_LIMIT = 32;
const SAFE_AREA = { top: 9, right: 11, bottom: 13, left: 15 };
const IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240"><rect width="640" height="240" fill="#0f766e"/></svg>';

export const MATRIX_AXES = {
  viewport: [
    { label: "360x640", width: 360, height: 640 },
    { label: "390x844", width: 390, height: 844 },
    { label: "768x1024", width: 768, height: 1024 },
    { label: "1440x900", width: 1440, height: 900 },
  ],
  zoom: [
    { label: "100%", value: 1 },
    { label: "200%", value: 2 },
  ],
  motion: ["no-preference", "reduce"],
  direction: ["ltr", "rtl"],
  bodyPlacement: ["normal", "translated", "scaled"],
} as const;

export type MatrixRow = {
  ordinal: number;
  key: string;
  viewport: { width: number; height: number };
  viewportLabel: (typeof MATRIX_AXES.viewport)[number]["label"];
  zoom: (typeof MATRIX_AXES.zoom)[number]["value"];
  zoomLabel: (typeof MATRIX_AXES.zoom)[number]["label"];
  motion: (typeof MATRIX_AXES.motion)[number];
  direction: (typeof MATRIX_AXES.direction)[number];
  bodyPlacement: (typeof MATRIX_AXES.bodyPlacement)[number];
};

export const MATRIX_ROWS: MatrixRow[] = [];
for (const viewport of MATRIX_AXES.viewport) {
  for (const zoom of MATRIX_AXES.zoom) {
    for (const motion of MATRIX_AXES.motion) {
      for (const direction of MATRIX_AXES.direction) {
        for (const bodyPlacement of MATRIX_AXES.bodyPlacement) {
          const ordinal = MATRIX_ROWS.length + 1;
          MATRIX_ROWS.push({
            ordinal,
            key: [
              `viewport=${viewport.label}`,
              `zoom=${zoom.label}`,
              `motion=${motion}`,
              `direction=${direction}`,
              `body-placement=${bodyPlacement}`,
            ].join("|"),
            viewport: { width: viewport.width, height: viewport.height },
            viewportLabel: viewport.label,
            zoom: zoom.value,
            zoomLabel: zoom.label,
            motion,
            direction,
            bodyPlacement,
          });
        }
      }
    }
  }
}

const EXPECTED_ROWS = 4 * 2 * 2 * 2 * 3;
const MATRIX_KEYS = new Set(MATRIX_ROWS.map((row) => row.key));
if (MATRIX_ROWS.length !== EXPECTED_ROWS || MATRIX_KEYS.size !== EXPECTED_ROWS) {
  throw new Error(
    "selection toolbar matrix definition is not the exact 4x2x2x2x3 cross-product",
  );
}

interface MatrixFailureCoordinate {
  row: string;
  state: string;
  check: string;
}

export interface MatrixSummary {
  selector: "selection-toolbar-reachable-geometry";
  axes: {
    viewport: string[];
    zoom: string[];
    motion: string[];
    direction: string[];
    bodyPlacement: string[];
  };
  coverage: {
    fullscreenBrowserClaims: 0;
    retainedStatesPerRow: 4;
    edgePositionsPerRow: 9;
  };
  rows: {
    expected: number;
    attempted: number;
    completed: number;
    missing: number;
    duplicate: number;
  };
  frames: {
    minimumPerState: number;
    total: number;
    minimumObserved: number | null;
    byState: Record<string, number>;
  };
  actions: {
    expectedPerRow: number;
    activations: Record<(typeof ACTION_LABELS)[number], number>;
    minimumWidth: number | null;
    minimumHeight: number | null;
  };
  overflow: {
    hiddenOrClippedRows: number;
    actionOverflowRows: number;
    edgeChecks: number;
    maximumActionScrollWidth: number;
  };
  extrema: {
    maximumPageOverflow: number;
    maximumVisualViewportOverflow: number;
    maximumSafeAreaOverflow: number;
    maximumScrollerOverflow: number;
    maximumPaneOverflow: number;
    maximumClipMismatch: number;
    maximumShadowOutset: number;
    minimumPaintClearance: number | null;
  };
  lifecycle: {
    closeStaleOwners: number | null;
    replacementStaleOwners: number | null;
    unmountStaleOwners: number | null;
  };
  failureCount: number;
  failures: MatrixFailureCoordinate[];
}

const actionOverflowRows = new WeakMap<MatrixSummary, Set<string>>();
const hiddenOrClippedRows = new WeakMap<MatrixSummary, Set<string>>();

export function createMatrixSummary(
  axes: typeof MATRIX_AXES,
  expectedRows: number,
): MatrixSummary {
  const summary: MatrixSummary = {
    selector: "selection-toolbar-reachable-geometry",
    axes: {
      viewport: axes.viewport.map((value) => value.label),
      zoom: axes.zoom.map((value) => value.label),
      motion: [...axes.motion],
      direction: [...axes.direction],
      bodyPlacement: [...axes.bodyPlacement],
    },
    coverage: {
      fullscreenBrowserClaims: 0,
      retainedStatesPerRow: 4,
      edgePositionsPerRow: 9,
    },
    rows: {
      expected: expectedRows,
      attempted: 0,
      completed: 0,
      missing: 0,
      duplicate: 0,
    },
    frames: {
      minimumPerState: FRAME_MINIMUM,
      total: 0,
      minimumObserved: null,
      byState: {},
    },
    actions: {
      expectedPerRow: ACTION_LABELS.length,
      activations: {
        Bold: 0,
        Italic: 0,
        Strikethrough: 0,
        "Inline code": 0,
        Link: 0,
        Comment: 0,
      },
      minimumWidth: null,
      minimumHeight: null,
    },
    overflow: {
      hiddenOrClippedRows: 0,
      actionOverflowRows: 0,
      edgeChecks: 0,
      maximumActionScrollWidth: 0,
    },
    extrema: {
      maximumPageOverflow: 0,
      maximumVisualViewportOverflow: 0,
      maximumSafeAreaOverflow: 0,
      maximumScrollerOverflow: 0,
      maximumPaneOverflow: 0,
      maximumClipMismatch: 0,
      maximumShadowOutset: 0,
      minimumPaintClearance: null,
    },
    lifecycle: {
      closeStaleOwners: null,
      replacementStaleOwners: null,
      unmountStaleOwners: null,
    },
    failureCount: 0,
    failures: [],
  };
  actionOverflowRows.set(summary, new Set());
  hiddenOrClippedRows.set(summary, new Set());
  return summary;
}

const bounded = (value: number) =>
  Math.round(Math.max(-1_000_000, Math.min(1_000_000, value)) * 100) / 100;

export function finalizeMatrixSummary(summary: MatrixSummary): MatrixSummary {
  summary.overflow.actionOverflowRows =
    actionOverflowRows.get(summary)?.size ?? 0;
  summary.overflow.hiddenOrClippedRows =
    hiddenOrClippedRows.get(summary)?.size ?? 0;
  for (const key of Object.keys(summary.extrema) as Array<
    keyof MatrixSummary["extrema"]
  >) {
    const value = summary.extrema[key];
    if (value !== null) summary.extrema[key] = bounded(value);
  }
  if (summary.actions.minimumWidth !== null) {
    summary.actions.minimumWidth = bounded(summary.actions.minimumWidth);
  }
  if (summary.actions.minimumHeight !== null) {
    summary.actions.minimumHeight = bounded(summary.actions.minimumHeight);
  }
  summary.overflow.maximumActionScrollWidth = bounded(
    summary.overflow.maximumActionScrollWidth,
  );
  return summary;
}

class MatrixCheckError extends Error {
  constructor(readonly check: string) {
    super(check);
  }
}

function check(value: unknown, name: string): asserts value {
  if (!value) throw new MatrixCheckError(name);
}

export function recordMatrixFailure(
  summary: MatrixSummary,
  row: string,
  state: string,
  error: unknown,
) {
  summary.failureCount++;
  if (summary.failures.length >= FAILURE_COORDINATE_LIMIT) return;
  summary.failures.push({
    row,
    state,
    check: error instanceof MatrixCheckError ? error.check : "unexpected",
  });
}

function loopback(url: string): boolean {
  const parsed = new URL(url);
  return (
    !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ||
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  );
}

export async function preventNonLoopbackTraffic(context: BrowserContext) {
  const state = { blocked: 0 };
  await context.route("**/*", async (route) => {
    if (!loopback(route.request().url())) {
      state.blocked++;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    if (!loopback(socket.url())) {
      state.blocked++;
      socket.close({ code: 1008, reason: "loopback only" });
      return;
    }
    socket.connectToServer();
  });
  return state;
}

export async function openMatrixDocument(
  page: Page,
  documentId: string,
  selectedText: string,
) {
  await page.addInitScript(() => {
    if (location.protocol === "http:" || location.protocol === "https:") {
      localStorage.setItem("markdoc:layout", "rich");
    }
  });
  await page.goto(`/d/${documentId}`);
  await waitForEditor(page);
  await page
    .getByTestId("save-state")
    .waitFor({ state: "attached", timeout: 30_000 });
  await page.locator(".md-rich").waitFor({ state: "visible" });
  check(
    await page
      .locator(".md-rich")
      .evaluate((root, text) => root.textContent?.includes(text), selectedText),
    "selected-fixture-present",
  );
}

async function setPageScale(page: Page, scale: number) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setPageScaleFactor", {
      pageScaleFactor: scale,
    });
    await page.waitForFunction(
      (expected) =>
        Math.abs((window.visualViewport?.scale ?? 1) - expected) < 0.05,
      scale,
    );
  } finally {
    await session.detach();
  }
}

export async function setMatrixEnvironment(page: Page, row: MatrixRow) {
  await page.evaluate(
    ({ direction, placement, safe }) => {
      document.documentElement.dir = direction;
      const root = document.documentElement;
      root.style.setProperty("--safe-area-inset-top", `${safe.top}px`);
      root.style.setProperty("--safe-area-inset-right", `${safe.right}px`);
      root.style.setProperty("--safe-area-inset-bottom", `${safe.bottom}px`);
      root.style.setProperty("--safe-area-inset-left", `${safe.left}px`);
      const body = document.body;
      body.style.transformOrigin = "top left";
      body.style.width = "";
      if (placement === "normal") {
        body.style.transform = "";
      } else if (placement === "translated") {
        body.style.transform = "translate(-14px, 12px)";
      } else {
        body.style.width = "calc(100% - 24px)";
        body.style.transform = "translate(19px, 13px) scale(0.87, 0.91)";
      }
    },
    {
      direction: row.direction,
      placement: row.bodyPlacement,
      safe: SAFE_AREA,
    },
  );
  await setPageScale(page, row.zoom);
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForSignal(signal: Promise<void>, checkName: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new MatrixCheckError(checkName)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export interface FontAsset {
  body: Buffer;
  contentType: string;
}

export interface LateResources {
  imageRequested: Promise<void>;
  fontRequested: Promise<void>;
  releaseImage: () => void;
  releaseFont: () => void;
  releaseAll: () => void;
}

export async function setupLateResources(
  page: Page,
  font: FontAsset,
): Promise<LateResources> {
  const imageRequested = deferred();
  const fontRequested = deferred();
  const imageRelease = deferred();
  const fontRelease = deferred();

  await page.route(
    "**/__selection-toolbar-matrix/late-image.svg",
    async (route: Route) => {
      imageRequested.resolve();
      await imageRelease.promise;
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: { "cache-control": "no-store" },
        body: IMAGE_SVG,
      });
    },
  );
  await page.route(
    "**/__selection-toolbar-matrix/late-font.woff2*",
    async (route: Route) => {
      fontRequested.resolve();
      await fontRelease.promise;
      await route.fulfill({
        status: 200,
        contentType: font.contentType,
        headers: { "cache-control": "no-store" },
        body: font.body,
      });
    },
  );

  let released = false;
  const releaseAll = () => {
    if (released) return;
    released = true;
    imageRelease.resolve();
    fontRelease.resolve();
  };
  return {
    imageRequested: imageRequested.promise,
    fontRequested: fontRequested.promise,
    releaseImage: imageRelease.resolve,
    releaseFont: fontRelease.resolve,
    releaseAll,
  };
}

async function nextFrame(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

async function centerSelection(page: Page) {
  await page.evaluate((selector) => {
    const scroller = document.querySelector<HTMLElement>(selector);
    const selection = window.getSelection();
    if (!scroller || !selection?.rangeCount || selection.isCollapsed) {
      throw new Error("active selection unavailable");
    }
    const range = selection.getRangeAt(0).getBoundingClientRect();
    const host = scroller.getBoundingClientRect();
    scroller.scrollTop +=
      range.top + range.height / 2 - (host.top + host.height / 2);
  }, RICH_SCROLLER);
  await nextFrame(page);
  await nextFrame(page);
}

interface FrameMeasurement {
  present: boolean;
  pageOverflow: number;
  visualViewportOverflow: number;
  safeAreaOverflow: number;
  scrollerOverflow: number;
  paneOverflow: number;
  bodyArrowOverflow: number;
  clipMismatch: number;
  shadowOutset: number;
  paintClearance: number;
  visibleStyle: boolean;
  bodyHit: boolean;
  arrowHit: boolean;
  shadowMeasured: boolean;
  borderMeasured: boolean;
  arrowMeasured: boolean;
  clipMeasured: boolean;
  rootOwner: boolean;
}

async function frameMeasurement(page: Page): Promise<FrameMeasurement> {
  return page.evaluate((scrollerSelector) => {
    interface Rect {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    }
    const rect = (value: DOMRect): Rect => ({
      left: value.left,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
    });
    const box = (
      left: number,
      top: number,
      width: number,
      height: number,
    ): Rect => ({
      left,
      top,
      right: left + Math.max(0, width),
      bottom: top + Math.max(0, height),
      width: Math.max(0, width),
      height: Math.max(0, height),
    });
    const intersect = (...values: Rect[]): Rect => {
      const left = Math.max(...values.map((value) => value.left));
      const top = Math.max(...values.map((value) => value.top));
      const right = Math.min(...values.map((value) => value.right));
      const bottom = Math.min(...values.map((value) => value.bottom));
      return box(left, top, right - left, bottom - top);
    };
    const union = (...values: Rect[]): Rect => {
      const left = Math.min(...values.map((value) => value.left));
      const top = Math.min(...values.map((value) => value.top));
      const right = Math.max(...values.map((value) => value.right));
      const bottom = Math.max(...values.map((value) => value.bottom));
      return box(left, top, right - left, bottom - top);
    };
    const outside = (value: Rect, bounds: Rect) =>
      Math.max(
        0,
        bounds.left - value.left,
        value.right - bounds.right,
        bounds.top - value.top,
        value.bottom - bounds.bottom,
      );
    const splitCssList = (value: string) => {
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < value.length; index++) {
        if (value[index] === "(") depth++;
        else if (value[index] === ")") depth--;
        else if (value[index] === "," && depth === 0) {
          parts.push(value.slice(start, index));
          start = index + 1;
        }
      }
      parts.push(value.slice(start));
      return parts;
    };
    const shadowRects = (target: Rect, value: string) => {
      if (!value || value === "none") return [];
      return splitCssList(value).flatMap((part) => {
        if (/\binset\b/.test(part)) return [];
        const withoutColors = part.replace(
          /(?:rgba?|hsla?|color|lab|lch|oklab|oklch)\([^)]*\)/gi,
          "",
        );
        const lengths = [
          ...withoutColors.matchAll(/-?\d*\.?\d+px/g),
        ].map((match) => Number.parseFloat(match[0]));
        if (lengths.length < 2) return [];
        const [offsetX, offsetY, blur = 0, spread = 0] = lengths;
        const extent = Math.max(0, blur * 1.5 + spread);
        return [
          box(
            target.left + offsetX - extent,
            target.top + offsetY - extent,
            target.width + extent * 2,
            target.height + extent * 2,
          ),
        ];
      });
    };
    const insetValues = (value: string) => {
      const match = /^inset\(([^)]+)/.exec(value);
      if (!match) return null;
      const lengths = [...match[1].matchAll(/-?\d*\.?\d+px/g)].map(
        (item) => Number.parseFloat(item[0]),
      );
      if (!lengths.length) return null;
      if (lengths.length === 1) {
        return [lengths[0], lengths[0], lengths[0], lengths[0]];
      }
      if (lengths.length === 2) {
        return [lengths[0], lengths[1], lengths[0], lengths[1]];
      }
      if (lengths.length === 3) {
        return [lengths[0], lengths[1], lengths[2], lengths[1]];
      }
      return lengths.slice(0, 4);
    };

    const root = document.documentElement;
    const pageOverflow = Math.max(
      0,
      root.scrollWidth - root.clientWidth,
      document.body.scrollWidth - root.clientWidth,
    );
    const bubble = document.querySelector<HTMLElement>(
      "[data-testid=selection-bubble]",
    );
    if (!bubble) {
      return {
        present: false,
        pageOverflow,
        visualViewportOverflow: 0,
        safeAreaOverflow: 0,
        scrollerOverflow: 0,
        paneOverflow: 0,
        bodyArrowOverflow: 0,
        clipMismatch: 0,
        shadowOutset: 0,
        paintClearance: 0,
        visibleStyle: false,
        bodyHit: false,
        arrowHit: false,
        shadowMeasured: false,
        borderMeasured: false,
        arrowMeasured: false,
        clipMeasured: false,
        rootOwner: false,
      };
    }

    const layer = bubble.closest<HTMLElement>(
      "[data-selection-bubble-layer]",
    )!;
    const arrow = bubble.querySelector<HTMLElement>("span[aria-hidden]");
    const scroller = document.querySelector<HTMLElement>(scrollerSelector)!;
    const pane = document.querySelector<HTMLElement>(
      '[data-testid="rich-column"]',
    )!;
    const layout = box(0, 0, root.clientWidth, root.clientHeight);
    const visualViewport = window.visualViewport;
    const visual = visualViewport
      ? box(
          visualViewport.offsetLeft,
          visualViewport.offsetTop,
          visualViewport.width,
          visualViewport.height,
        )
      : layout;
    const rootStyle = getComputedStyle(root);
    const inset = (name: string) => {
      const value = Number.parseFloat(rootStyle.getPropertyValue(name));
      return Number.isFinite(value) ? value : 0;
    };
    const safe = box(
      visual.left + inset("--safe-area-inset-left"),
      visual.top + inset("--safe-area-inset-top"),
      visual.width -
        inset("--safe-area-inset-left") -
        inset("--safe-area-inset-right"),
      visual.height -
        inset("--safe-area-inset-top") -
        inset("--safe-area-inset-bottom"),
    );
    const scrollerBox = rect(scroller.getBoundingClientRect());
    const paneBox = rect(pane.getBoundingClientRect());
    const allowed = intersect(layout, visual, safe, scrollerBox, paneBox);

    const body = rect(bubble.getBoundingClientRect());
    const bodyStyle = getComputedStyle(bubble);
    const arrowBox = arrow
      ? rect(arrow.getBoundingClientRect())
      : box(body.left, body.top, 0, 0);
    const arrowStyle = arrow ? getComputedStyle(arrow) : null;
    const bodyShadow = shadowRects(body, bodyStyle.boxShadow);
    const arrowShadow = arrowStyle
      ? shadowRects(arrowBox, arrowStyle.boxShadow)
      : [];
    const bodyAndArrow = union(body, arrowBox);
    const painted = union(
      body,
      arrowBox,
      ...bodyShadow,
      ...arrowShadow,
    );

    const layerBox = rect(layer.getBoundingClientRect());
    const layerStyle = getComputedStyle(layer);
    const clipInsets = insetValues(layerStyle.clipPath);
    const cssWidth =
      Number.parseFloat(layerStyle.width) || layerBox.width || 1;
    const cssHeight =
      Number.parseFloat(layerStyle.height) || layerBox.height || 1;
    const scaleX = layerBox.width / cssWidth;
    const scaleY = layerBox.height / cssHeight;
    const clip = clipInsets
      ? box(
          layerBox.left + clipInsets[3] * scaleX,
          layerBox.top + clipInsets[0] * scaleY,
          layerBox.width - (clipInsets[1] + clipInsets[3]) * scaleX,
          layerBox.height - (clipInsets[0] + clipInsets[2]) * scaleY,
        )
      : layerBox;
    const visiblePaint = intersect(painted, clip);
    const clipMismatch = Math.max(
      Math.abs(clip.left - allowed.left),
      Math.abs(clip.top - allowed.top),
      Math.abs(clip.right - allowed.right),
      Math.abs(clip.bottom - allowed.bottom),
    );
    const shadowOutset = Math.max(
      0,
      body.left - painted.left,
      painted.right - body.right,
      body.top - painted.top,
      painted.bottom - body.bottom,
    );
    const paintClearance = Math.min(
      visiblePaint.left - allowed.left,
      allowed.right - visiblePaint.right,
      visiblePaint.top - allowed.top,
      allowed.bottom - visiblePaint.bottom,
    );
    const hit = (target: HTMLElement, value: Rect) => {
      const x = value.left + value.width / 2;
      const y = value.top + value.height / 2;
      return document
        .elementsFromPoint(x, y)
        .some((element) => element === target || target.contains(element));
    };
    const borderMeasured = [
      bodyStyle.borderTopWidth,
      bodyStyle.borderRightWidth,
      bodyStyle.borderBottomWidth,
      bodyStyle.borderLeftWidth,
    ].every((value) => Number.isFinite(Number.parseFloat(value)));

    return {
      present: true,
      pageOverflow,
      visualViewportOverflow: outside(visiblePaint, visual),
      safeAreaOverflow: outside(visiblePaint, safe),
      scrollerOverflow: outside(visiblePaint, scrollerBox),
      paneOverflow: outside(visiblePaint, paneBox),
      bodyArrowOverflow: outside(bodyAndArrow, allowed),
      clipMismatch,
      shadowOutset,
      paintClearance,
      visibleStyle:
        bodyStyle.display !== "none" &&
        bodyStyle.visibility === "visible" &&
        Number.parseFloat(bodyStyle.opacity || "1") > 0 &&
        bodyStyle.pointerEvents !== "none",
      bodyHit: hit(bubble, body),
      arrowHit: Boolean(arrow) && hit(arrow!, arrowBox),
      shadowMeasured: bodyStyle.boxShadow !== "none",
      borderMeasured,
      arrowMeasured:
        Boolean(arrow) &&
        arrowBox.width > 0 &&
        arrowBox.height > 0 &&
        Boolean(arrowStyle?.transform && arrowStyle.transform !== "none"),
      clipMeasured: Boolean(clipInsets),
      rootOwner: layer.parentElement === document.documentElement,
    };
  }, RICH_SCROLLER);
}

async function sampleFrames(
  page: Page,
  row: MatrixRow,
  summary: MatrixSummary,
  state: string,
  visible: boolean,
) {
  let observed = 0;
  for (let frame = 0; frame < FRAME_MINIMUM; frame++) {
    await nextFrame(page);
    const sample = await frameMeasurement(page);
    observed++;
    summary.frames.total++;
    summary.frames.byState[state] =
      (summary.frames.byState[state] ?? 0) + 1;
    const numeric = [
      sample.pageOverflow,
      sample.visualViewportOverflow,
      sample.safeAreaOverflow,
      sample.scrollerOverflow,
      sample.paneOverflow,
      sample.bodyArrowOverflow,
      sample.clipMismatch,
      sample.shadowOutset,
      sample.paintClearance,
    ];
    check(
      numeric.every((value) => Number.isFinite(value)),
      `${state}:finite-painted-geometry`,
    );

    summary.extrema.maximumPageOverflow = Math.max(
      summary.extrema.maximumPageOverflow,
      sample.pageOverflow,
    );
    summary.extrema.maximumVisualViewportOverflow = Math.max(
      summary.extrema.maximumVisualViewportOverflow,
      sample.visualViewportOverflow,
    );
    summary.extrema.maximumSafeAreaOverflow = Math.max(
      summary.extrema.maximumSafeAreaOverflow,
      sample.safeAreaOverflow,
    );
    summary.extrema.maximumScrollerOverflow = Math.max(
      summary.extrema.maximumScrollerOverflow,
      sample.scrollerOverflow,
    );
    summary.extrema.maximumPaneOverflow = Math.max(
      summary.extrema.maximumPaneOverflow,
      sample.paneOverflow,
    );
    summary.extrema.maximumClipMismatch = Math.max(
      summary.extrema.maximumClipMismatch,
      sample.clipMismatch,
    );
    summary.extrema.maximumShadowOutset = Math.max(
      summary.extrema.maximumShadowOutset,
      sample.shadowOutset,
    );
    if (visible) {
      summary.extrema.minimumPaintClearance =
        summary.extrema.minimumPaintClearance === null
          ? sample.paintClearance
          : Math.min(
              summary.extrema.minimumPaintClearance,
              sample.paintClearance,
            );
    }
    if (
      Math.max(
        sample.visualViewportOverflow,
        sample.safeAreaOverflow,
        sample.scrollerOverflow,
        sample.paneOverflow,
        sample.bodyArrowOverflow,
        sample.clipMismatch,
      ) > 0.75
    ) {
      hiddenOrClippedRows.get(summary)!.add(row.key);
    }

    check(sample.pageOverflow === 0, `${state}:page-overflow`);
    if (!visible) {
      check(!sample.present, `${state}:toolbar-hidden`);
      continue;
    }
    check(sample.present, `${state}:toolbar-visible`);
    check(
      sample.visualViewportOverflow <= 0.75,
      `${state}:visual-viewport-overflow`,
    );
    check(
      sample.safeAreaOverflow <= 0.75,
      `${state}:safe-area-overflow`,
    );
    check(sample.scrollerOverflow <= 0.75, `${state}:scroller-overflow`);
    check(sample.paneOverflow <= 0.75, `${state}:pane-overflow`);
    check(
      sample.bodyArrowOverflow <= 0.75,
      `${state}:body-border-arrow-contained`,
    );
    check(
      sample.clipMismatch <= 0.75,
      `${state}:paint-clip-matches-bounds`,
    );
    check(sample.visibleStyle, `${state}:computed-visible-style`);
    check(sample.bodyHit, `${state}:body-hit-test`);
    check(sample.arrowHit, `${state}:arrow-hit-test`);
    check(sample.shadowMeasured, `${state}:shadow-computed`);
    check(sample.borderMeasured, `${state}:border-computed`);
    check(sample.arrowMeasured, `${state}:arrow-tail-computed`);
    check(sample.clipMeasured, `${state}:clip-computed`);
    check(sample.rootOwner, `${state}:document-root-owner`);
  }
  summary.frames.minimumObserved =
    summary.frames.minimumObserved === null
      ? observed
      : Math.min(summary.frames.minimumObserved, observed);
  check(observed >= FRAME_MINIMUM, `${state}:minimum-frames`);
}

async function positionSelection(
  page: Page,
  text: string,
  vertical: "top" | "center" | "bottom",
  horizontal: "left" | "center" | "right",
) {
  const target = page.locator(".md-rich p").filter({ hasText: text }).first();
  await target.evaluate((element, align) => {
    element.style.textAlign = align;
  }, horizontal);
  await selectTextInRich(page, text);
  await page.evaluate(
    ({ selector, verticalPosition }) => {
      const scroller = document.querySelector<HTMLElement>(selector)!;
      const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      const host = scroller.getBoundingClientRect();
      const desired =
        verticalPosition === "top"
          ? host.top + 2
          : verticalPosition === "bottom"
            ? host.bottom - range.height - 2
            : host.top + (host.height - range.height) / 2;
      scroller.scrollTop += range.top - desired;
    },
    { selector: RICH_SCROLLER, verticalPosition: vertical },
  );
  await nextFrame(page);
  await nextFrame(page);
}

async function actionMeasurement(button: Locator) {
  return button.evaluate((element) => {
    const buttonRect = element.getBoundingClientRect();
    const toolbar = element.closest<HTMLElement>('[role="toolbar"]')!;
    const toolbarRect = toolbar.getBoundingClientRect();
    const style = getComputedStyle(element);
    const x = buttonRect.left + buttonRect.width / 2;
    const y = buttonRect.top + buttonRect.height / 2;
    return {
      x,
      y,
      width: buttonRect.width,
      height: buttonRect.height,
      hit: document
        .elementsFromPoint(x, y)
        .some(
          (candidate) =>
            candidate === element || element.contains(candidate),
        ),
      contained:
        buttonRect.left >= toolbarRect.left - 0.5 &&
        buttonRect.right <= toolbarRect.right + 0.5 &&
        buttonRect.top >= toolbarRect.top - 0.5 &&
        buttonRect.bottom <= toolbarRect.bottom + 0.5,
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
      scrollLeft: toolbar.scrollLeft,
      scrollWidth: toolbar.scrollWidth,
      clientWidth: toolbar.clientWidth,
    };
  });
}

async function proveActionsReachable(
  page: Page,
  row: MatrixRow,
  summary: MatrixSummary,
  state: string,
) {
  const bubble = page.getByTestId("selection-bubble");
  await bubble.waitFor({ state: "visible", timeout: 15_000 });
  const buttons = bubble.getByRole("button");
  check((await buttons.count()) === ACTION_LABELS.length, `${state}:six-actions`);
  const scrollPositions: number[] = [];
  let overflow = false;

  for (const label of ACTION_LABELS) {
    const button = bubble.getByRole("button", { name: label, exact: true });
    await button.click({ trial: true });
    const measured = await actionMeasurement(button);
    check(
      [measured.width, measured.height, measured.scrollLeft, measured.scrollWidth]
        .every((value) => Number.isFinite(value)),
      `${state}:${label}:finite-action-geometry`,
    );
    summary.actions.minimumWidth =
      summary.actions.minimumWidth === null
        ? measured.width
        : Math.min(summary.actions.minimumWidth, measured.width);
    summary.actions.minimumHeight =
      summary.actions.minimumHeight === null
        ? measured.height
        : Math.min(summary.actions.minimumHeight, measured.height);
    summary.overflow.maximumActionScrollWidth = Math.max(
      summary.overflow.maximumActionScrollWidth,
      measured.scrollWidth,
    );
    scrollPositions.push(measured.scrollLeft);
    overflow ||= measured.scrollWidth > measured.clientWidth + 0.5;
    check(measured.width >= 32, `${state}:${label}:minimum-width`);
    check(measured.height >= 32, `${state}:${label}:minimum-height`);
    check(measured.hit, `${state}:${label}:hit-test`);
    check(measured.contained, `${state}:${label}:scroll-into-view`);
    check(
      measured.pointerEvents !== "none" &&
        measured.visibility === "visible",
      `${state}:${label}:computed-reachable`,
    );
  }

  summary.overflow.edgeChecks++;
  if (overflow) {
    actionOverflowRows.get(summary)!.add(row.key);
    check(
      Math.max(...scrollPositions) - Math.min(...scrollPositions) > 0.5,
      `${state}:overflow-scroll-range`,
    );
  }
}

export async function sampleEdgeReachability(
  page: Page,
  row: MatrixRow,
  summary: MatrixSummary,
  edgeText: string,
) {
  for (const vertical of ["top", "center", "bottom"] as const) {
    for (const horizontal of ["left", "center", "right"] as const) {
      const state = `edge-${vertical}-${horizontal}`;
      await positionSelection(page, edgeText, vertical, horizontal);
      await sampleFrames(page, row, summary, state, true);
      await proveActionsReachable(page, row, summary, state);
    }
  }
}

export async function sampleRetainedStates(
  page: Page,
  row: MatrixRow,
  summary: MatrixSummary,
  selectedText: string,
) {
  await selectTextInRich(page, selectedText);
  await centerSelection(page);
  await sampleFrames(page, row, summary, "visible", true);

  await page.evaluate((selector) => {
    const scroller = document.querySelector<HTMLElement>(selector)!;
    const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    const host = scroller.getBoundingClientRect();
    scroller.scrollTop += range.bottom - host.top - 2;
  }, RICH_SCROLLER);
  await sampleFrames(page, row, summary, "partial", true);

  await page.evaluate((selector) => {
    document.querySelector<HTMLElement>(selector)!.scrollTop += 8;
  }, RICH_SCROLLER);
  await sampleFrames(page, row, summary, "hidden", false);

  await selectTextInRich(page, selectedText);
  await centerSelection(page);
  await sampleFrames(page, row, summary, "restored", true);
}

function selectionSignature(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const rects = Array.from(
      selection.getRangeAt(0).getClientRects(),
      (value) => ({
        left: value.left,
        top: value.top,
        width: value.width,
        height: value.height,
      }),
    );
    return {
      count: rects.length,
      width: rects.reduce((total, value) => total + value.width, 0),
      height: rects.reduce((total, value) => total + value.height, 0),
      top: Math.min(...rects.map((value) => value.top)),
      bottom: Math.max(...rects.map((value) => value.top + value.height)),
    };
  });
}

function signatureDelta(
  before: Awaited<ReturnType<typeof selectionSignature>>,
  after: Awaited<ReturnType<typeof selectionSignature>>,
) {
  if (!before || !after) return 0;
  return (
    Math.abs(before.count - after.count) +
    Math.abs(before.width - after.width) +
    Math.abs(before.height - after.height) +
    Math.abs(before.top - after.top) +
    Math.abs(before.bottom - after.bottom)
  );
}

export async function completeLateImage(
  page: Page,
  row: MatrixRow,
  summary: MatrixSummary,
  resources: LateResources,
  selectedText: string,
  imageAlt: string,
) {
  await selectTextInRich(page, selectedText);
  await centerSelection(page);
  const before = await selectionSignature(page);
  const image = page.locator(`.md-rich img[alt="${imageAlt}"]`);
  const beforeHeight = await image.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await waitForSignal(resources.imageRequested, "image-request-started");
  resources.releaseImage();
  const decoded = await image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    return {
      complete: element.complete,
      width: element.naturalWidth,
      height: element.naturalHeight,
      paintedHeight: element.getBoundingClientRect().height,
    };
  });
  check(
    decoded.complete && decoded.width === 640 && decoded.height === 240,
    "natural-image-decode",
  );
  const after = await selectionSignature(page);
  check(
    decoded.paintedHeight > beforeHeight + 100 ||
      signatureDelta(before, after) > 1,
    "natural-image-reflow",
  );
  await sampleFrames(page, row, summary, "image-complete", true);
}

export async function completeLateFont(
  page: Page,
  row: MatrixRow,
  summary: MatrixSummary,
  resources: LateResources,
  selectedText: string,
) {
  const family = `ToolbarMatrix${row.ordinal}`;
  await selectTextInRich(page, selectedText);
  await centerSelection(page);
  await page.evaluate(
    ({ text, fontFamily, rowOrdinal }) => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>(".md-rich p"),
      ).find((element) => element.textContent?.includes(text));
      if (!target) throw new Error("font target unavailable");
      target.style.fontFamily = '"Courier New", monospace';
      const face = new FontFace(
        fontFamily,
        `url("/__selection-toolbar-matrix/late-font.woff2?row=${rowOrdinal}")`,
        { display: "swap" },
      );
      document.fonts.add(face);
      target.style.fontFamily = `"${fontFamily}", "Courier New", monospace`;
      (
        window as typeof window & {
          __selectionToolbarFont?: {
            family: string;
            loaded: Promise<FontFace>;
          };
        }
      ).__selectionToolbarFont = {
        family: fontFamily,
        loaded: face.load(),
      };
    },
    { text: selectedText, fontFamily: family, rowOrdinal: row.ordinal },
  );
  await waitForSignal(resources.fontRequested, "font-request-started");
  await nextFrame(page);
  await nextFrame(page);
  const before = await selectionSignature(page);
  resources.releaseFont();
  const loaded = await page.evaluate(async () => {
    const state = (
      window as typeof window & {
        __selectionToolbarFont?: {
          family: string;
          loaded: Promise<FontFace>;
        };
      }
    ).__selectionToolbarFont;
    if (!state) return false;
    const face = await state.loaded;
    await document.fonts.ready;
    return (
      face.status === "loaded" &&
      document.fonts.check(`16px "${state.family}"`)
    );
  });
  check(loaded, "actual-font-completion");
  const after = await selectionSignature(page);
  check(signatureDelta(before, after) > 0.25, "actual-font-reflow");
  await sampleFrames(page, row, summary, "font-complete", true);
}

async function physicalAction(
  page: Page,
  bubble: Locator,
  label: (typeof ACTION_LABELS)[number],
) {
  const button = bubble.getByRole("button", { name: label, exact: true });
  await button.click({ trial: true });
  const measured = await actionMeasurement(button);
  check(measured.hit && measured.contained, `${label}:physical-hit`);
  await page.mouse.click(measured.x, measured.y);
}

async function waitForSource(page: Page, expected: string, checkName: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await codeText(page)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new MatrixCheckError(checkName);
}

async function undoTo(page: Page, source: string, checkName: string) {
  await page.keyboard.press("Control+z");
  await waitForSource(page, source, checkName);
}

export async function exerciseActions(
  page: Page,
  row: MatrixRow,
  summary: MatrixSummary,
  actionText: string,
) {
  const marks = [
    ["Bold", `**${actionText}**`],
    ["Italic", `*${actionText}*`],
    ["Strikethrough", `~~${actionText}~~`],
    ["Inline code", `\`${actionText}\``],
  ] as const;

  for (const [label, replacement] of marks) {
    await selectTextInRich(page, actionText);
    await centerSelection(page);
    const bubble = page.getByTestId("selection-bubble");
    await bubble.waitFor({ state: "visible" });
    const source = await codeText(page);
    check(
      source.split(actionText).length === 2,
      `${label}:unique-action-fixture`,
    );
    await physicalAction(page, bubble, label);
    summary.actions.activations[label]++;
    await waitForSource(
      page,
      source.replace(actionText, replacement),
      `${label}:exact-format-once`,
    );
    await undoTo(page, source, `${label}:undo-reset`);
  }

  await selectTextInRich(page, actionText);
  await centerSelection(page);
  let bubble = page.getByTestId("selection-bubble");
  const source = await codeText(page);
  await physicalAction(page, bubble, "Link");
  summary.actions.activations.Link++;
  await page.getByTestId("link-url").waitFor({ state: "visible" });
  await page.getByTestId("link-url").fill("#toolbar-matrix");
  await page.getByTestId("link-submit").click();
  await waitForSource(
    page,
    source.replace(actionText, `[${actionText}](#toolbar-matrix)`),
    "Link:exact-format-once",
  );
  await undoTo(page, source, "Link:undo-reset");

  await selectTextInRich(page, actionText);
  await centerSelection(page);
  bubble = page.getByTestId("selection-bubble");
  await physicalAction(page, bubble, "Comment");
  summary.actions.activations.Comment++;
  const pending = page.getByTestId("pending-comment");
  await pending.waitFor({ state: "visible" });
  check((await pending.count()) === 1, "Comment:one-pending-action");
  check(
    (await pending.innerText()).includes(actionText),
    "Comment:correct-selection",
  );
  await page.getByTestId("comment-composer").press("Escape");
  await pending.waitFor({ state: "detached" });
  if ((await page.getByTestId("comments-panel").count()) > 0) {
    if ((await page.getByTestId("sheet-backdrop").count()) > 0) {
      await page.keyboard.press("Escape");
    } else {
      await page.getByTestId("comments-toggle").click();
    }
    await page
      .getByTestId("comments-panel")
      .waitFor({ state: "detached", timeout: 15_000 });
  }
  check((await codeText(page)) === source, "Comment:no-wrong-format");

  for (const label of ACTION_LABELS) {
    check(
      summary.actions.activations[label] <= row.ordinal,
      `${label}:duplicate-activation`,
    );
  }
}

type OwnershipSnapshot = {
  stale: number;
  duplicate: number;
  pendingFrames: number;
  activeListeners: number;
  activeObservers: number;
  layerConnected: boolean;
};

type OwnershipProbe = {
  capture(): number;
  health(token: number): OwnershipSnapshot;
};

type ProbeWindow = Window & {
  __selectionToolbarOwnership?: OwnershipProbe;
};

export async function installOwnershipProbe(page: Page) {
  await page.addInitScript((scrollerSelector) => {
    interface ListenerRecord {
      sequence: number;
      target: EventTarget;
      type: string;
      listener: EventListenerOrEventListenerObject;
      wrapped: EventListener;
      callback: number;
      capture: boolean;
      active: boolean;
    }
    interface ObserverRecord {
      kind: "resize" | "mutation";
      instance: ResizeObserver | MutationObserver;
      callback: ResizeObserverCallback | MutationCallback;
      callbackId: number;
      targets: Set<Node>;
      active: boolean;
    }
    interface FrameRecord {
      id: number;
      source: number | null;
      pending: boolean;
    }
    interface Owner {
      callbacks: Set<number>;
      listeners: ListenerRecord[];
      observers: ObserverRecord[];
      layer: HTMLElement;
    }

    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const NativeResizeObserver = window.ResizeObserver;
    const NativeMutationObserver = window.MutationObserver;
    const listeners: ListenerRecord[] = [];
    const observers: ObserverRecord[] = [];
    const frames: FrameRecord[] = [];
    const owners = new Map<number, Owner>();
    const callbackIds = new WeakMap<object, number>();
    let nextCallback = 1;
    let nextOwner = 1;
    let sequence = 0;
    let activeCallback: number | null = null;

    const callbackId = (callback: object) => {
      let id = callbackIds.get(callback);
      if (!id) {
        id = nextCallback++;
        callbackIds.set(callback, id);
      }
      return id;
    };
    const captureValue = (options?: boolean | AddEventListenerOptions) =>
      typeof options === "boolean" ? options : Boolean(options?.capture);
    const invoke = (
      listener: EventListenerOrEventListenerObject,
      target: EventTarget,
      event: Event,
    ) => {
      if (typeof listener === "function") return listener.call(target, event);
      return listener.handleEvent(event);
    };

    // Wrappers only observe browser-delivered work; the probe never replays a
    // listener, observer callback, or animation frame.
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      if (!listener) return nativeAdd.call(this, type, listener, options);
      const callback = callbackId(listener as object);
      const wrapped: EventListener = (event) => {
        const previous = activeCallback;
        activeCallback = callback;
        try {
          invoke(listener, this, event);
        } finally {
          activeCallback = previous;
        }
      };
      listeners.push({
        sequence: sequence++,
        target: this,
        type,
        listener,
        wrapped,
        callback,
        capture: captureValue(options),
        active: true,
      });
      return nativeAdd.call(this, type, wrapped, options);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      listener,
      options,
    ) {
      if (!listener) return nativeRemove.call(this, type, listener, options);
      const capture = captureValue(options);
      const record = [...listeners]
        .reverse()
        .find(
          (entry) =>
            entry.active &&
            entry.target === this &&
            entry.type === type &&
            entry.listener === listener &&
            entry.capture === capture,
        );
      if (!record) return nativeRemove.call(this, type, listener, options);
      record.active = false;
      return nativeRemove.call(this, type, record.wrapped, options);
    };

    window.requestAnimationFrame = (callback) => {
      const record: FrameRecord = {
        id: 0,
        source: activeCallback,
        pending: true,
      };
      record.id = nativeRequest((time) => {
        record.pending = false;
        callback(time);
      });
      frames.push(record);
      return record.id;
    };
    window.cancelAnimationFrame = (id) => {
      const record = [...frames].reverse().find((entry) => entry.id === id);
      if (record) record.pending = false;
      nativeCancel(id);
    };

    const trackedObserver = <
      Callback extends ResizeObserverCallback | MutationCallback,
      Instance extends ResizeObserver | MutationObserver,
    >(
      kind: ObserverRecord["kind"],
      callback: Callback,
      construct: (wrapped: Callback) => Instance,
    ) => {
      const id = callbackId(callback as object);
      const wrapped = ((entries: never[], observer: Instance) => {
        const previous = activeCallback;
        activeCallback = id;
        try {
          callback(entries, observer as never);
        } finally {
          activeCallback = previous;
        }
      }) as Callback;
      const instance = construct(wrapped);
      const record: ObserverRecord = {
        kind,
        instance,
        callback,
        callbackId: id,
        targets: new Set(),
        active: true,
      };
      observers.push(record);
      const observe = instance.observe.bind(instance);
      const unobserve =
        "unobserve" in instance ? instance.unobserve.bind(instance) : null;
      const disconnect = instance.disconnect.bind(instance);
      instance.observe = ((target: Node, options?: MutationObserverInit) => {
        record.targets.add(target);
        if (kind === "resize") {
          (observe as ResizeObserver["observe"])(target as Element);
        } else {
          (observe as MutationObserver["observe"])(
            target,
            options as MutationObserverInit,
          );
        }
      }) as Instance["observe"];
      if (unobserve) {
        (instance as ResizeObserver).unobserve = ((target: Element) => {
          record.targets.delete(target);
          (unobserve as ResizeObserver["unobserve"])(target);
        }) as ResizeObserver["unobserve"];
      }
      instance.disconnect = (() => {
        record.targets.clear();
        record.active = false;
        disconnect();
      }) as Instance["disconnect"];
      return instance;
    };

    if (NativeResizeObserver) {
      window.ResizeObserver = function (callback: ResizeObserverCallback) {
        return trackedObserver(
          "resize",
          callback,
          (wrapped) => new NativeResizeObserver(wrapped),
        );
      } as unknown as typeof ResizeObserver;
      window.ResizeObserver.prototype = NativeResizeObserver.prototype;
    }
    window.MutationObserver = function (callback: MutationCallback) {
      return trackedObserver(
        "mutation",
        callback,
        (wrapped) => new NativeMutationObserver(wrapped),
      );
    } as unknown as typeof MutationObserver;
    window.MutationObserver.prototype = NativeMutationObserver.prototype;

    const health = (token: number): OwnershipSnapshot => {
      const owner = owners.get(token);
      if (!owner) throw new Error("unknown owner");
      const activeListeners = owner.listeners.filter(
        (record) => record.active,
      );
      const activeObservers = owner.observers.filter(
        (record) => record.active,
      );
      const disconnectedTargets = activeListeners.filter(
        (record) =>
          record.target instanceof Node && !record.target.isConnected,
      ).length;
      const staleObserverTargets = activeObservers.reduce(
        (total, record) =>
          total +
          [...record.targets].filter((target) => !target.isConnected).length,
        0,
      );
      const duplicate = activeListeners.filter((record, index) =>
        activeListeners.slice(0, index).some(
          (other) =>
            other.target === record.target &&
            other.type === record.type &&
            other.callback === record.callback &&
            other.capture === record.capture,
        ),
      ).length;
      const ownerFrames = frames.filter(
        (record) =>
          record.source !== null && owner.callbacks.has(record.source),
      );
      return {
        stale: disconnectedTargets + staleObserverTargets,
        duplicate,
        pendingFrames: ownerFrames.filter((record) => record.pending).length,
        activeListeners: activeListeners.length,
        activeObservers: activeObservers.length,
        layerConnected: owner.layer.isConnected,
      };
    };

    const probe: OwnershipProbe = {
      capture() {
        const editor = document.querySelector<HTMLElement>(".md-rich");
        const scroller =
          document.querySelector<HTMLElement>(scrollerSelector);
        const layer = document.querySelector<HTMLElement>(
          "[data-selection-bubble-layer]",
        );
        if (!editor || !scroller || !layer) throw new Error("owner unavailable");
        const schedule = [...listeners]
          .reverse()
          .find(
            (record) =>
              record.active &&
              record.target === document &&
              record.type === "selectionchange" &&
              listeners.some(
                (other) =>
                  other.active &&
                  other.target === scroller &&
                  other.type === "scroll" &&
                  other.callback === record.callback,
              ) &&
              listeners.some(
                (other) =>
                  other.active &&
                  other.target === window &&
                  other.type === "resize" &&
                  other.callback === record.callback,
              ),
          );
        if (!schedule) throw new Error("schedule unavailable");
        const firstSchedule = Math.min(
          ...listeners
            .filter((record) => record.callback === schedule.callback)
            .map((record) => record.sequence),
        );
        const lastSchedule = Math.max(
          ...listeners
            .filter((record) => record.callback === schedule.callback)
            .map((record) => record.sequence),
        );
        const ownerObservers = observers.filter(
          (record) =>
            record.targets.has(editor) && record.targets.has(scroller),
        );
        const callbacks = new Set([
          schedule.callback,
          ...ownerObservers.map((record) => record.callbackId),
        ]);
        for (const record of listeners) {
          if (
            record.active &&
            record.target === window &&
            record.type.startsWith("pointer") &&
            record.sequence >= firstSchedule &&
            record.sequence <= lastSchedule
          ) {
            callbacks.add(record.callback);
          }
          if (
            record.active &&
            ((record.target === editor &&
              ["blur", "load"].includes(record.type)) ||
              (record.target === layer && record.type === "focusout"))
          ) {
            callbacks.add(record.callback);
          }
        }
        const ownerListeners = listeners.filter((record) =>
          callbacks.has(record.callback),
        );
        const token = nextOwner++;
        owners.set(token, {
          callbacks,
          listeners: ownerListeners,
          observers: ownerObservers,
          layer,
        });
        return token;
      },
      health,
    };
    (window as ProbeWindow).__selectionToolbarOwnership = probe;
  }, RICH_SCROLLER);
}

async function probeCall<T>(
  page: Page,
  method: "capture" | "health",
  token?: number,
): Promise<T> {
  return page.evaluate(
    ({ methodName, ownerToken }) => {
      const probe = (window as ProbeWindow).__selectionToolbarOwnership;
      if (!probe) throw new Error("ownership probe unavailable");
      if (methodName === "capture") return probe.capture();
      return probe.health(ownerToken!);
    },
    { methodName: method, ownerToken: token },
  ) as Promise<T>;
}

function assertDisposed(snapshot: OwnershipSnapshot, state: string) {
  check(snapshot.stale === 0, `${state}:stale-owner`);
  check(snapshot.duplicate === 0, `${state}:duplicate-listener`);
  check(snapshot.pendingFrames === 0, `${state}:pending-frame`);
  check(snapshot.activeListeners === 0, `${state}:active-listener`);
  check(snapshot.activeObservers === 0, `${state}:active-observer`);
  check(!snapshot.layerConnected, `${state}:orphan-layer`);
}

export async function runLifecycleChecks(
  page: Page,
  summary: MatrixSummary,
  firstDocument: string,
  replacementDocument: string,
  selectedText: string,
) {
  await openMatrixDocument(page, firstDocument, selectedText);
  await selectTextInRich(page, selectedText);
  await centerSelection(page);
  const first = await probeCall<number>(page, "capture");

  await page.locator(".md-rich p").first().click();
  await nextFrame(page);
  await nextFrame(page);
  check(
    (await page.getByTestId("selection-bubble").count()) === 0,
    "close:bubble-removed",
  );
  const close = await probeCall<OwnershipSnapshot>(page, "health", first);
  summary.lifecycle.closeStaleOwners =
    close.stale + close.duplicate + close.pendingFrames;
  check(summary.lifecycle.closeStaleOwners === 0, "close:stale-owner");

  await page.getByRole("link", { name: "Back to documents" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  const replaced = await probeCall<OwnershipSnapshot>(page, "health", first);
  assertDisposed(replaced, "replacement");
  summary.lifecycle.replacementStaleOwners =
    replaced.stale +
    replaced.duplicate +
    replaced.pendingFrames +
    replaced.activeListeners +
    replaced.activeObservers +
    Number(replaced.layerConnected);

  await page
    .getByTestId("document-card")
    .filter({ hasText: "Toolbar lifecycle replacement" })
    .click();
  await page.waitForURL(
    (url) => url.pathname === `/d/${replacementDocument}`,
  );
  await waitForEditor(page);
  await selectTextInRich(page, selectedText);
  await centerSelection(page);
  const second = await probeCall<number>(page, "capture");
  check(second !== first, "replacement:new-owner");

  await page.getByRole("link", { name: "Back to documents" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  const unmounted = await probeCall<OwnershipSnapshot>(
    page,
    "health",
    second,
  );
  assertDisposed(unmounted, "unmount");
  summary.lifecycle.unmountStaleOwners =
    unmounted.stale +
    unmounted.duplicate +
    unmounted.pendingFrames +
    unmounted.activeListeners +
    unmounted.activeObservers +
    Number(unmounted.layerConnected);
}
