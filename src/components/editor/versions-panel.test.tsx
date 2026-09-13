// @vitest-environment jsdom
import {
  StrictMode,
  useLayoutEffect,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollabSession } from "@/editor/collab/session";
import type { VersionSummary } from "@/lib/api";

const versions = vi.fn();
const version = vi.fn();
const renameVersion = vi.fn();
const restoreVersion = vi.fn();
const copyVersion = vi.fn();
const push = vi.fn();
const router = { push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };
let activeRouter = router;
const pendingNotice = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      versions: (...args: unknown[]) => versions(...args),
      version: (...args: unknown[]) => version(...args),
      renameVersion: (...args: unknown[]) => renameVersion(...args),
      restoreVersion: (...args: unknown[]) => restoreVersion(...args),
      copyVersion: (...args: unknown[]) => copyVersion(...args),
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => activeRouter,
}));

vi.mock("@/lib/notice", () => ({
  setPendingNotice: (...args: unknown[]) => pendingNotice(...args),
}));

import { ApiError } from "@/lib/api";
import { VersionDiffView, VersionsPanel } from "./versions-panel";

const DOC_ID = "doc-1484";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type CapturedEvent<T extends HTMLElement> = {
  currentTarget: T;
  target: T;
  key?: string;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
};

interface CapturedProps<T extends HTMLElement> {
  onClick?: (event: CapturedEvent<T>) => void;
  onChange?: (event: CapturedEvent<T>) => void;
  onBlur?: (event: CapturedEvent<T>) => void;
  onKeyDown?: (event: CapturedEvent<T>) => void;
  ref?: (element: T | null) => void;
}

function capturedProps<T extends HTMLElement>(element: T): CapturedProps<T> {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  return (element as unknown as Record<string, CapturedProps<T>>)[propsKey];
}

function interceptClick(
  element: HTMLButtonElement,
  invokeHandler: (
    original: NonNullable<CapturedProps<HTMLButtonElement>["onClick"]>,
    event: CapturedEvent<HTMLButtonElement>,
  ) => void,
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  const record = element as unknown as Record<
    string,
    CapturedProps<HTMLButtonElement>
  >;
  const props = record[propsKey];
  const original = props.onClick;
  if (!original) throw new Error("React click handler was not attached");
  record[propsKey] = {
    ...props,
    onClick: (event) => invokeHandler(original, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

type CapturedEventProp = "onClick" | "onChange" | "onBlur" | "onKeyDown";

function interceptEvent<T extends HTMLElement>(
  element: T,
  prop: CapturedEventProp,
  invokeHandler: (
    original: (event: CapturedEvent<T>) => void,
    event: CapturedEvent<T>,
  ) => void,
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  const record = element as unknown as Record<string, CapturedProps<T>>;
  const props = record[propsKey];
  const original = props[prop] as ((event: CapturedEvent<T>) => void) | undefined;
  if (!original) throw new Error(`React ${prop} handler was not attached`);
  record[propsKey] = {
    ...props,
    [prop]: (event: CapturedEvent<T>) => invokeHandler(original, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

type ExactSyntheticEvent<T extends HTMLElement> = SyntheticEvent<T> & {
  _reactName?: unknown;
};

const MangledSyntheticEvent = class a {};

function cloneSyntheticEvent<T extends HTMLElement>(
  event: CapturedEvent<T>,
  overrides: Partial<ExactSyntheticEvent<T>> = {},
  syntheticConstructor: new () => object = MangledSyntheticEvent,
): CapturedEvent<T> {
  const prototype = Object.create(Object.getPrototypeOf(event), {
    constructor: { value: syntheticConstructor },
  });
  return Object.assign(
    Object.create(prototype) as CapturedEvent<T>,
    event,
    overrides,
  );
}

function interceptMangledEvent<T extends HTMLElement>(
  element: T,
  prop: CapturedEventProp,
) {
  return interceptEvent(element, prop, (original, event) => {
    const mangled = cloneSyntheticEvent(event);
    expect(Object.getPrototypeOf(mangled).constructor).toBe(
      MangledSyntheticEvent,
    );
    expect(Object.getPrototypeOf(mangled).constructor.name).toBe("a");
    original(mangled);
  });
}

function capturedEvent<T extends HTMLElement>(currentTarget: T, key?: string): CapturedEvent<T> {
  return {
    currentTarget,
    target: currentTarget,
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function invoke<T extends HTMLElement>(
  handler: ((event: CapturedEvent<T>) => void) | undefined,
  source: T,
  key?: string,
) {
  if (!handler) throw new Error("React handler was not attached to the element");
  const event = capturedEvent(source, key);
  handler(event);
  return event;
}

function expectInert<T extends HTMLElement>(
  handler: ((event: CapturedEvent<T>) => void) | undefined,
  source: T,
  panel: HTMLElement,
  key?: string,
) {
  const markup = panel.innerHTML;
  const focused = document.activeElement;
  const event = invoke(handler, source, key);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
  expect(panel.innerHTML).toBe(markup);
  expect(document.activeElement).toBe(focused);
  return event;
}

function VersionsBoundary({
  session: currentSession,
  onClose,
  onPreview,
  refreshKey = 0,
  present = true,
  mountKey = "panel",
  boundary = 0,
  onBoundary,
}: {
  session: CollabSession;
  onClose: () => void;
  onPreview: (preview: unknown) => void;
  refreshKey?: number;
  present?: boolean;
  mountKey?: string;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <VersionsPanel
      key={mountKey}
      session={currentSession}
      onClose={onClose}
      onPreview={onPreview}
      refreshKey={refreshKey}
    />
  ) : null;
}

function SettleInLayout({ settle }: { settle: () => void }) {
  useLayoutEffect(() => settle(), [settle]);
  return null;
}

type StrictVersionsProps = ComponentProps<typeof VersionsPanel>;

async function renderStrictVersions(
  root: ReturnType<typeof createRoot>,
  props: StrictVersionsProps,
  generation = "panel",
) {
  await act(async () => {
    root.render(
      <StrictMode>
        <VersionsPanel key={generation} {...props} />
      </StrictMode>,
    );
  });
}

function session(docId: string): CollabSession {
  return { docId, role: "owner" } as unknown as CollabSession;
}

function contentResult(summary: VersionSummary, content: string) {
  return { version: { ...summary, content } };
}

function versionItem(title: string): HTMLElement {
  const item = screen.getByText(title).closest<HTMLElement>('[data-testid="version-item"]');
  if (!item) throw new Error(`Missing version item for ${title}`);
  return item;
}

function spinnerFor(title: string): Element | null {
  return versionItem(title).querySelector(".animate-spin");
}

function expectMutationControlsToBeDisabled(disabled: boolean) {
  for (const testId of ["version-restore", "version-rename", "version-copy"]) {
    if (disabled) expect(screen.getByTestId(testId)).toBeDisabled();
    else expect(screen.getByTestId(testId)).toBeEnabled();
  }
}

type VersionDiffKeyHandler = (
  event: ReactKeyboardEvent<HTMLDivElement>,
) => void;
type VersionDiffActionKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

interface VersionDiffReactProps {
  onKeyDown?: VersionDiffKeyHandler;
  ref?: (element: HTMLElement | null) => void;
}

interface VersionDiffViewFixture {
  root: ReturnType<typeof createRoot>;
  host: HTMLDivElement;
}

const VERSION_DIFF_OLD =
  "first old\n\n\n\nshared one\nsecond old\n\n\n\nshared two\nthird old";
const VERSION_DIFF_CURRENT =
  "first new\n\n\n\nshared one\nsecond new\n\n\n\nshared two\nthird new";
const versionDiffViews: VersionDiffViewFixture[] = [];

function versionDiffSession(
  current = VERSION_DIFF_CURRENT,
  docId = "version-diff-document",
): CollabSession {
  return {
    docId,
    role: "owner",
    version: 0,
    subscribe: () => () => {},
    ytext: { toString: () => current },
  } as unknown as CollabSession;
}

function versionDiffPreview(
  content = VERSION_DIFF_OLD,
  id = "version-diff-version",
) {
  return {
    version: {
      ...named,
      id,
      number: 7,
      title: "Diff fixture",
    },
    content,
  };
}

function versionDiffProps(element: HTMLElement): {
  propsKey: string;
  record: Record<string, VersionDiffReactProps>;
  props: VersionDiffReactProps;
} {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) throw new Error("Version diff React props were not attached");
  const record = element as unknown as Record<string, VersionDiffReactProps>;
  return { propsKey, record, props: record[propsKey] };
}

function versionDiffKeyHandler(element: HTMLDivElement) {
  const handler = versionDiffProps(element).props.onKeyDown;
  if (!handler) throw new Error("Version diff key handler was not attached");
  return handler;
}

function versionDiffRef(element: HTMLElement) {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  const props = propsKey
    ? (element as unknown as Record<string, VersionDiffReactProps>)[propsKey]
    : undefined;
  if (typeof props?.ref === "function") return props.ref;
  const fiberKey = Object.keys(element).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  if (!fiberKey) throw new Error("Version diff React fiber was not attached");
  const fiber = (
    element as unknown as Record<
      string,
      { ref?: (node: HTMLElement | null) => void }
    >
  )[fiberKey];
  if (typeof fiber.ref !== "function") {
    throw new Error("Version diff ref was not attached");
  }
  return fiber.ref;
}

function interceptVersionDiffKey(
  element: HTMLDivElement,
  invokeHandler: (
    current: VersionDiffKeyHandler,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void,
) {
  const { propsKey, record, props } = versionDiffProps(element);
  const current = props.onKeyDown;
  if (!current) throw new Error("Version diff key handler was not attached");
  record[propsKey] = {
    ...props,
    onKeyDown: (event) => invokeHandler(current, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

function trustKeyboardEvent(event: KeyboardEvent, ownerWindow: Window) {
  const implementationSymbol = Object.getOwnPropertySymbols(event).find(
    (symbol) => String(symbol) === "Symbol(impl)",
  );
  if (!implementationSymbol) {
    throw new Error("Keyboard event implementation slot was not available");
  }
  const implementation = (
    event as unknown as Record<symbol, { isTrusted: boolean; view: Window }>
  )[implementationSymbol];
  implementation.view = ownerWindow;
  const descriptor = Object.getOwnPropertyDescriptor(
    implementation,
    "isTrusted",
  );
  if (!descriptor?.writable) {
    throw new Error("Keyboard event trust slot was not writable");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  expect(event.isTrusted).toBe(true);
  expect(event.view).toBe(ownerWindow);
}

function createVersionDiffKey(
  target: HTMLElement,
  key: "Home" | "End",
  init: KeyboardEventInit = {},
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Version diff owner window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  trustKeyboardEvent(event, ownerWindow);
  return event;
}

function dispatchVersionDiffKey(
  target: HTMLElement,
  key: "Home" | "End",
  init: KeyboardEventInit = {},
  focus = true,
) {
  const event = createVersionDiffKey(target, key, init);
  let allowed = true;
  act(() => {
    if (focus) target.focus();
    allowed = target.dispatchEvent(event);
  });
  return { event, allowed };
}

function versionDiffComparePreview() {
  const preview = versionDiffPreview(VERSION_DIFF_CURRENT, "version-diff-new");
  return {
    ...preview,
    base: {
      version: {
        ...named,
        id: "version-diff-old",
        number: 4,
        title: "Older fixture",
      },
      content: VERSION_DIFF_OLD,
    },
    range: [preview.version],
  };
}

function versionDiffActions(host: HTMLElement) {
  const controls = within(host);
  return {
    swap: controls.queryByTestId("diff-swap") as HTMLButtonElement | null,
    previous: controls.getByTestId("diff-prev") as HTMLButtonElement,
    next: controls.getByTestId("diff-next") as HTMLButtonElement,
  };
}

function createVersionDiffActionKey(
  target: HTMLButtonElement,
  key: VersionDiffActionKey,
  init: KeyboardEventInit = {},
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Version diff owner window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    code: key,
    ...init,
  });
  trustKeyboardEvent(event, ownerWindow);
  return event;
}

function dispatchVersionDiffActionKey(
  target: HTMLButtonElement,
  key: VersionDiffActionKey,
  init: KeyboardEventInit = {},
  focus = true,
) {
  const event = createVersionDiffActionKey(target, key, init);
  let allowed = true;
  act(() => {
    if (focus) target.focus();
    allowed = target.dispatchEvent(event);
  });
  return { event, allowed };
}

type DeliveredVersionDiffActionKey = ReactKeyboardEvent<HTMLElement>;

function versionDiffReactHandler<T>(
  element: HTMLElement,
  name: "onKeyDownCapture" | "onKeyDown",
) {
  const { props } = versionDiffProps(element);
  const handler = (props as unknown as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`Version diff ${name} handler was not attached`);
  }
  return handler as T;
}

function replaceVersionDiffReactHandlers(
  element: HTMLElement,
  replacements: Partial<
    Record<
      "onKeyDownCapture" | "onKeyDown",
      (event: DeliveredVersionDiffActionKey) => void
    >
  >,
) {
  const { propsKey, record, props } = versionDiffProps(element);
  const replacement = {
    ...props,
    ...replacements,
  } as VersionDiffReactProps;
  record[propsKey] = replacement;
  return () => {
    if (record[propsKey] === replacement) record[propsKey] = props;
  };
}

function distinctVersionDiffReactKey(
  event: DeliveredVersionDiffActionKey,
  prototype: object,
) {
  const wrapper = Object.create(prototype) as DeliveredVersionDiffActionKey;
  for (const property of [
    "type",
    "currentTarget",
    "target",
    "nativeEvent",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "isTrusted",
    "key",
    "code",
    "location",
    "altKey",
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "repeat",
    "isComposing",
    "view",
  ] as const) {
    Object.defineProperty(wrapper, property, {
      configurable: true,
      get: () => event[property],
    });
  }
  return wrapper;
}

type VersionsToolbarKey =
  | "ArrowRight"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowUp"
  | "Home"
  | "End"
  | "Enter"
  | " ";

function versionsToolbarButtons(host: ParentNode = document) {
  const toolbar = within(host as HTMLElement).getByRole("toolbar", {
    name: "Version history actions",
  });
  return {
    toolbar,
    refresh: within(toolbar).getByRole<HTMLButtonElement>("button", {
      name: "Refresh versions",
    }),
    close: within(toolbar).getByRole<HTMLButtonElement>("button", {
      name: "Close version history",
    }),
  };
}

function versionRowSelects(host: ParentNode = document) {
  return within(host as HTMLElement)
    .getAllByTestId("version-item")
    .map((item) => {
      const select = item.querySelector<HTMLButtonElement>("button");
      if (!select) throw new Error("Version row select button was not rendered");
      return select;
    });
}

function createVersionsToolbarKey(
  target: HTMLElement,
  key: VersionsToolbarKey,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Version toolbar owner window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  const implementationSymbol = Object.getOwnPropertySymbols(event).find(
    (symbol) => String(symbol) === "Symbol(impl)",
  );
  const implementation = implementationSymbol
    ? (
        event as unknown as Record<
          symbol,
          { isTrusted: boolean; view: Window | null }
        >
      )[implementationSymbol]
    : null;
  if (!implementation) {
    throw new Error("Keyboard event implementation slot was not available");
  }
  implementation.view = ownerWindow;
  if (trusted) trustKeyboardEvent(event, ownerWindow);
  return event;
}

async function dispatchVersionsToolbarKey(
  target: HTMLElement,
  key: VersionsToolbarKey,
  init: KeyboardEventInit = {},
  focus = true,
) {
  const event = createVersionsToolbarKey(target, key, init);
  await dispatchVersionsToolbarEvent(target, event, focus);
  return event;
}

async function dispatchVersionsToolbarEvent(
  target: HTMLElement,
  event: KeyboardEvent,
  focus = true,
) {
  await act(async () => {
    if (focus) target.focus();
    target.dispatchEvent(event);
    await Promise.resolve();
  });
}

function normalizeVersionsToolbarOwnerWindowBoundary(
  ownerWindow: Window & typeof globalThis,
  transformPath?: (
    event: Event,
    path: readonly EventTarget[],
  ) => readonly EventTarget[],
) {
  const eventPrototype = ownerWindow.Event.prototype;
  const nativeComposedPath = eventPrototype.composedPath;
  const currentTargetDescriptor = Object.getOwnPropertyDescriptor(
    eventPrototype,
    "currentTarget",
  );
  if (!currentTargetDescriptor?.get) {
    throw new Error("Event currentTarget getter was unavailable");
  }
  vi.spyOn(eventPrototype, "composedPath").mockImplementation(function (
    this: Event,
  ) {
    const path = nativeComposedPath.call(this);
    const normalized =
      path.length > 0
        ? [...path.slice(0, -1), ownerWindow]
        : path;
    return [...(transformPath?.(this, normalized) ?? normalized)];
  });
  vi.spyOn(eventPrototype, "currentTarget", "get").mockImplementation(function (
    this: Event,
  ) {
    const currentTarget = currentTargetDescriptor.get!.call(this) as
      | EventTarget
      | null;
    if (typeof currentTarget !== "object" || currentTarget === null) {
      return currentTarget;
    }
    const candidate = currentTarget as EventTarget & {
      document?: Document;
      window?: unknown;
    };
    return candidate.document === ownerWindow.document &&
      candidate.window === currentTarget
      ? ownerWindow
      : currentTarget;
  });
}

function replaceVersionsJsdomPathTerminal(
  event: Event,
  terminal: EventTarget,
) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find((candidate): candidate is {
      _path: Array<{ item: Record<symbol, unknown> }>;
    } => {
      if (!candidate || typeof candidate !== "object") return false;
      return Array.isArray((candidate as { _path?: unknown })._path);
    });
  const entry = implementation?._path.at(-1);
  const currentTerminal = event.composedPath().at(-1);
  const wrapper = entry
    ? Object.getOwnPropertySymbols(entry.item).find(
        (symbol) => entry.item[symbol] === currentTerminal,
      )
    : undefined;
  if (!entry || !wrapper) {
    throw new Error("Unable to replace jsdom's version-row path terminal");
  }
  const item: Record<symbol, unknown> = {};
  Object.defineProperty(item, wrapper, { value: terminal });
  entry.item = item;
  if (event.composedPath().at(-1) !== terminal) {
    throw new Error("The jsdom version-row path terminal did not update");
  }
}

function createVersionDiffView(
  preview = versionDiffPreview(),
  current = VERSION_DIFF_CURRENT,
  generation = "initial",
) {
  const host = document.createElement("div");
  document.body.append(host);
  const fixture = { root: createRoot(host), host };
  versionDiffViews.push(fixture);
  act(() => {
    fixture.root.render(
      <StrictMode>
        <VersionDiffView
          key={generation}
          session={versionDiffSession(current)}
          preview={preview}
        />
      </StrictMode>,
    );
  });
  return fixture;
}

function renderVersionDiffView(
  fixture: VersionDiffViewFixture,
  preview: ReturnType<typeof versionDiffPreview>,
  current = VERSION_DIFF_CURRENT,
  generation = "initial",
) {
  act(() => {
    fixture.root.render(
      <StrictMode>
        <VersionDiffView
          key={generation}
          session={versionDiffSession(current)}
          preview={preview}
        />
      </StrictMode>,
    );
  });
}

function versionDiffRoot(host: HTMLElement) {
  const root = host.querySelector<HTMLDivElement>(
    '[data-testid="version-diff"]',
  );
  if (!root) throw new Error("Version diff root was not rendered");
  return root;
}

function expectNoVersionDiffExternalWork() {
  expect(versions).not.toHaveBeenCalled();
  expect(version).not.toHaveBeenCalled();
  expect(renameVersion).not.toHaveBeenCalled();
  expect(restoreVersion).not.toHaveBeenCalled();
  expect(copyVersion).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(pendingNotice).not.toHaveBeenCalled();
}

const named: VersionSummary = {
  id: "ver-1",
  number: 1,
  title: "Draft",
  kind: "named",
  createdBy: "user-alice",
  createdByName: "Alice",
  commitSha: null,
  createdAt: "2026-09-01T09:00:00.000Z",
  size: 12,
};

beforeEach(() => {
  activeRouter = router;
  versions.mockReset().mockResolvedValue({ versions: [named] });
  version.mockReset().mockResolvedValue({ version: { ...named, content: "# Draft" } });
  renameVersion.mockReset();
  restoreVersion.mockReset().mockResolvedValue({ ok: true });
  copyVersion.mockReset().mockResolvedValue({ id: "copy-1", title: "Copy" });
  push.mockReset();
  pendingNotice.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VersionDiffView · header action keyboard navigation", () => {
  let originalScrollIntoView: PropertyDescriptor | undefined;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
  });

  afterEach(async () => {
    while (versionDiffViews.length > 0) {
      const fixture = versionDiffViews.pop()!;
      await act(async () => fixture.root.unmount());
      fixture.host.remove();
    }
    if (originalScrollIntoView) {
      Object.defineProperty(
        Element.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  it.each([
    ["ArrowLeft", "previous", "swap"],
    ["ArrowLeft", "next", "previous"],
    ["ArrowUp", "previous", "swap"],
    ["ArrowUp", "next", "previous"],
    ["ArrowRight", "swap", "previous"],
    ["ArrowRight", "previous", "next"],
    ["ArrowDown", "swap", "previous"],
    ["ArrowDown", "previous", "next"],
    ["Home", "previous", "swap"],
    ["Home", "next", "swap"],
    ["End", "swap", "next"],
    ["End", "previous", "next"],
  ] as const)(
    "moves once with %s from %s to %s without activating or scrolling",
    (key, sourceKind, destinationKind) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const fixture = createVersionDiffView(
        versionDiffComparePreview(),
        "unused live text",
      );
      fireEvent.click(versionDiffActions(fixture.host).next);
      const actions = versionDiffActions(fixture.host);
      const source = actions[sourceKind];
      const destination = actions[destinationKind];
      if (!source || !destination) throw new Error("Expected comparison action");
      const activations = {
        swap: vi.fn(),
        previous: vi.fn(),
        next: vi.fn(),
      };
      actions.swap?.addEventListener("click", activations.swap);
      actions.previous.addEventListener("click", activations.previous);
      actions.next.addEventListener("click", activations.next);
      const beforeHeader = within(fixture.host)
        .getByTestId("diff-header")
        .textContent;
      const beforeCounter = within(fixture.host)
        .getByTestId("diff-counter")
        .textContent;
      const root = versionDiffRoot(fixture.host);
      const nav = actions.previous.parentElement!;
      document.documentElement.scrollTop = 9;
      fixture.host.scrollTop = 11;
      root.scrollTop = 13;
      nav.scrollTop = 15;
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      scrollIntoView.mockClear();

      const result = dispatchVersionDiffActionKey(source, key, {}, false);

      expect(result.allowed).toBe(false);
      expect(result.event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(focus.mock.contexts[0]).toBe(destination);
      expect(destination).toHaveFocus();
      expect(activations.swap).not.toHaveBeenCalled();
      expect(activations.previous).not.toHaveBeenCalled();
      expect(activations.next).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(within(fixture.host).getByTestId("diff-header")).toHaveTextContent(
        beforeHeader ?? "",
      );
      expect(
        within(fixture.host).getByTestId("diff-counter"),
      ).toHaveTextContent(beforeCounter ?? "");
      expect(document.documentElement.scrollTop).toBe(9);
      expect(fixture.host.scrollTop).toBe(11);
      expect(root.scrollTop).toBe(13);
      expect(nav.scrollTop).toBe(15);
      expectNoVersionDiffExternalWork();
    },
  );

  it.each([
    ["ArrowLeft", "Numpad4", "previous", "swap"],
    ["ArrowUp", "Numpad8", "next", "previous"],
    ["ArrowRight", "Numpad6", "swap", "previous"],
    ["ArrowDown", "Numpad2", "previous", "next"],
    ["Home", "Numpad7", "next", "swap"],
    ["End", "Numpad1", "swap", "next"],
  ] as const)(
    "uses semantic %s with unrestricted %s and NUMPAD location",
    (key, code, sourceKind, destinationKind) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const fixture = createVersionDiffView(
        versionDiffComparePreview(),
        "unused live text",
      );
      fireEvent.click(versionDiffActions(fixture.host).next);
      const actions = versionDiffActions(fixture.host);
      const source = actions[sourceKind];
      const destination = actions[destinationKind];
      if (!source || !destination) throw new Error("Expected comparison action");
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      scrollIntoView.mockClear();

      const result = dispatchVersionDiffActionKey(
        source,
        key,
        {
          code,
          location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
        },
        false,
      );

      expect(result.event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(destination).toHaveFocus();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(
        within(fixture.host).getByTestId("diff-counter"),
      ).toHaveTextContent("2 of 3 changes");
      expectNoVersionDiffExternalWork();
    },
  );

  it("uses enabled DOM order in base and no-base layouts while skipping disabled boundaries", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const baseFixture = createVersionDiffView(
      versionDiffComparePreview(),
      "unused live text",
    );
    let actions = versionDiffActions(baseFixture.host);
    expect(actions.previous).toBeDisabled();
    expect(actions.next).toBeEnabled();
    actions.swap!.focus();
    preventDefault.mockClear();
    focus.mockClear();
    const first = dispatchVersionDiffActionKey(
      actions.swap!,
      "End",
      {},
      false,
    );
    expect(first.event.defaultPrevented).toBe(true);
    expect(actions.next).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(actions.next);
    actions = versionDiffActions(baseFixture.host);
    fireEvent.click(actions.next);
    actions = versionDiffActions(baseFixture.host);
    expect(actions.next).toBeDisabled();
    expect(actions.previous).toBeEnabled();
    actions.swap!.focus();
    preventDefault.mockClear();
    focus.mockClear();
    scrollIntoView.mockClear();
    const last = dispatchVersionDiffActionKey(
      actions.swap!,
      "ArrowRight",
      {},
      false,
    );
    expect(last.event.defaultPrevented).toBe(true);
    expect(actions.previous).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(scrollIntoView).not.toHaveBeenCalled();

    const noBaseFixture = createVersionDiffView(
      versionDiffPreview(),
      VERSION_DIFF_CURRENT,
      "no-base",
    );
    actions = versionDiffActions(noBaseFixture.host);
    expect(actions.swap).toBeNull();
    expect(actions.previous).toBeDisabled();
    expect(actions.next).toBeEnabled();
    actions.next.focus();
    preventDefault.mockClear();
    focus.mockClear();
    const boundary = dispatchVersionDiffActionKey(
      actions.next,
      "Home",
      {},
      false,
    );
    expect(boundary.allowed).toBe(true);
    expect(boundary.event.defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(actions.next).toHaveFocus();

    fireEvent.click(actions.next);
    actions = versionDiffActions(noBaseFixture.host);
    actions.previous.focus();
    preventDefault.mockClear();
    focus.mockClear();
    scrollIntoView.mockClear();
    const middle = dispatchVersionDiffActionKey(
      actions.previous,
      "End",
      {},
      false,
    );
    expect(middle.event.defaultPrevented).toBe(true);
    expect(actions.next).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expectNoVersionDiffExternalWork();
  });

  it.each([
    ["ArrowLeft", "swap"],
    ["ArrowUp", "swap"],
    ["Home", "swap"],
    ["ArrowRight", "next"],
    ["ArrowDown", "next"],
    ["End", "next"],
  ] as const)(
    "leaves the exact %s %s boundary unprevented and inert",
    (key, sourceKind) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const fixture = createVersionDiffView(
        versionDiffComparePreview(),
        "unused live text",
      );
      fireEvent.click(versionDiffActions(fixture.host).next);
      const actions = versionDiffActions(fixture.host);
      const source = actions[sourceKind];
      if (!source) throw new Error("Expected boundary action");
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      scrollIntoView.mockClear();

      const result = dispatchVersionDiffActionKey(source, key, {}, false);

      expect(result.allowed).toBe(true);
      expect(result.event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      expect(
        within(fixture.host).getByTestId("diff-counter"),
      ).toHaveTextContent("2 of 3 changes");
      expectNoVersionDiffExternalWork();
    },
  );

  it.each([
    ["Control", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["repeat", { repeat: true }],
    ["composition", { isComposing: true }],
    ["non-bubbling", { bubbles: false }],
    ["non-cancelable", { cancelable: false }],
  ] as const)("rejects %s and leaves the publication available", (_name, init) => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fixture = createVersionDiffView(
      versionDiffComparePreview(),
      "unused live text",
    );
    fireEvent.click(versionDiffActions(fixture.host).next);
    const actions = versionDiffActions(fixture.host);
    actions.previous.focus();
    preventDefault.mockClear();
    focus.mockClear();

    const rejected = dispatchVersionDiffActionKey(
      actions.previous,
      "ArrowRight",
      init,
      false,
    );
    expect(rejected.event.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(actions.previous).toHaveFocus();

    const accepted = dispatchVersionDiffActionKey(
      actions.previous,
      "ArrowRight",
      {},
      false,
    );
    expect(accepted.event.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(actions.next).toHaveFocus();
  });

  it("rejects untrusted, prior-canceled, stopped, and fabricated deliveries", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fixture = createVersionDiffView(
      versionDiffComparePreview(),
      "unused live text",
    );
    fireEvent.click(versionDiffActions(fixture.host).next);
    const actions = versionDiffActions(fixture.host);
    const source = actions.previous;
    const ownerWindow = source.ownerDocument.defaultView!;
    source.focus();
    preventDefault.mockClear();
    focus.mockClear();

    const untrusted = new ownerWindow.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
      code: "ArrowRight",
      view: ownerWindow,
    });
    act(() => source.dispatchEvent(untrusted));
    const canceled = createVersionDiffActionKey(source, "ArrowRight");
    canceled.preventDefault();
    preventDefault.mockClear();
    act(() => source.dispatchEvent(canceled));
    const stop = (event: Event) => event.stopPropagation();
    versionDiffRoot(fixture.host).addEventListener("keydown", stop, {
      capture: true,
      once: true,
    });
    dispatchVersionDiffActionKey(source, "ArrowRight", {}, false);
    const actionBubble = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(source, "onKeyDown");
    expect(() =>
      actionBubble(
        Object.create(KeyboardEvent.prototype) as DeliveredVersionDiffActionKey,
      ),
    ).not.toThrow();

    expect(untrusted.defaultPrevented).toBe(false);
    expect(canceled.defaultPrevented).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(source).toHaveFocus();
    expectNoVersionDiffExternalWork();
  });

  it("accepts distinct exact capture and bubble wrappers across group and action boundaries", () => {
    const nativePreventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fixture = createVersionDiffView(
      versionDiffComparePreview(),
      "unused live text",
    );
    fireEvent.click(versionDiffActions(fixture.host).next);
    const actions = versionDiffActions(fixture.host);
    const source = actions.previous;
    const destination = actions.next;
    const header = versionDiffRoot(fixture.host)
      .firstElementChild as HTMLDivElement;
    const groupCapture = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(header, "onKeyDownCapture");
    const actionCapture = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(source, "onKeyDownCapture");
    const actionBubble = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(source, "onKeyDown");
    const groupBubble = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(header, "onKeyDown");
    const capturePrevent = vi.fn();
    const captureStop = vi.fn();
    const captureDefault = vi.fn(() => false);
    const captureStopped = vi.fn(() => false);
    const capturePersist = vi.fn();
    const bubbleStop = vi.fn();
    const bubbleStopped = vi.fn(() => false);
    const bubblePersist = vi.fn();
    let activeBubble: DeliveredVersionDiffActionKey | null = null;
    const bubbleDefault = vi.fn(() =>
      activeBubble?.isDefaultPrevented() ?? false,
    );
    const bubblePrevent = vi.fn(function (this: object) {
      expect(this).toBe(bubbleWrapper);
      if (!activeBubble) throw new Error("Missing active bubble wrapper");
      Reflect.apply(activeBubble.preventDefault, activeBubble, []);
    });
    const capturePrototype = Object.create(null) as object;
    const bubblePrototype = Object.create(null) as object;
    Object.defineProperties(capturePrototype, {
      preventDefault: { configurable: true, value: capturePrevent },
      stopPropagation: { configurable: true, value: captureStop },
      isDefaultPrevented: { configurable: true, value: captureDefault },
      isPropagationStopped: { configurable: true, value: captureStopped },
      persist: { configurable: true, value: capturePersist },
    });
    Object.defineProperties(bubblePrototype, {
      preventDefault: { configurable: true, value: bubblePrevent },
      stopPropagation: { configurable: true, value: bubbleStop },
      isDefaultPrevented: { configurable: true, value: bubbleDefault },
      isPropagationStopped: { configurable: true, value: bubbleStopped },
      persist: { configurable: true, value: bubblePersist },
    });
    let captureWrapper: DeliveredVersionDiffActionKey | null = null;
    let bubbleWrapper: DeliveredVersionDiffActionKey | null = null;
    const restoreHeader = replaceVersionDiffReactHandlers(header, {
      onKeyDownCapture: (event) => {
        captureWrapper = distinctVersionDiffReactKey(
          event,
          capturePrototype,
        );
        groupCapture(captureWrapper);
      },
      onKeyDown: (event) => {
        if (!bubbleWrapper) throw new Error("Missing bubble wrapper");
        activeBubble = event;
        try {
          groupBubble(bubbleWrapper);
        } finally {
          activeBubble = null;
        }
      },
    });
    const restoreAction = replaceVersionDiffReactHandlers(source, {
      onKeyDownCapture: () => {
        if (!captureWrapper) throw new Error("Missing capture wrapper");
        actionCapture(captureWrapper);
      },
      onKeyDown: (event) => {
        bubbleWrapper = distinctVersionDiffReactKey(event, bubblePrototype);
        activeBubble = event;
        try {
          actionBubble(bubbleWrapper);
        } finally {
          activeBubble = null;
        }
      },
    });
    source.focus();
    nativePreventDefault.mockClear();
    focus.mockClear();

    try {
      const result = dispatchVersionDiffActionKey(
        source,
        "ArrowRight",
        {},
        false,
      );

      expect(result.event.defaultPrevented).toBe(true);
      expect(captureWrapper).not.toBe(bubbleWrapper);
      expect(Object.getPrototypeOf(captureWrapper!)).toBe(capturePrototype);
      expect(Object.getPrototypeOf(bubbleWrapper!)).toBe(bubblePrototype);
      expect(capturePrevent).not.toHaveBeenCalled();
      expect(captureStop).not.toHaveBeenCalled();
      expect(capturePersist).not.toHaveBeenCalled();
      expect(bubblePrevent).toHaveBeenCalledOnce();
      expect(bubbleStop).not.toHaveBeenCalled();
      expect(bubblePersist).not.toHaveBeenCalled();
      expect(captureDefault).not.toBe(bubbleDefault);
      expect(captureStopped).not.toBe(bubbleStopped);
      expect(nativePreventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(destination).toHaveFocus();
    } finally {
      restoreAction();
      restoreHeader();
    }
  });

  it.each([
    "preventDefault",
    "stopPropagation",
    "isDefaultPrevented",
    "isPropagationStopped",
    "persist",
  ] as const)(
    "rejects retained capture %s drift and admits a clean event",
    (property) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const fixture = createVersionDiffView(
        versionDiffComparePreview(),
        "unused live text",
      );
      fireEvent.click(versionDiffActions(fixture.host).next);
      const actions = versionDiffActions(fixture.host);
      const source = actions.previous;
      const destination = actions.next;
      const header = versionDiffRoot(fixture.host)
        .firstElementChild as HTMLDivElement;
      const originalCapture = versionDiffReactHandler<
        (event: DeliveredVersionDiffActionKey) => void
      >(source, "onKeyDownCapture");
      const originalBubble = versionDiffReactHandler<
        (event: DeliveredVersionDiffActionKey) => void
      >(source, "onKeyDown");
      let captured: DeliveredVersionDiffActionKey | null = null;
      const restore = replaceVersionDiffReactHandlers(source, {
        onKeyDownCapture: (event) => {
          captured = event;
          originalCapture(event);
        },
        onKeyDown: (event) => {
          if (captured) {
            Object.defineProperty(captured, property, {
              configurable: true,
              value:
                property === "preventDefault" ||
                  property === "stopPropagation" ||
                  property === "persist"
                  ? vi.fn()
                  : vi.fn(() => false),
            });
          }
          originalBubble(event);
        },
      });
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();

      const rejected = dispatchVersionDiffActionKey(
        source,
        "ArrowRight",
        {},
        false,
      );
      restore();

      expect(rejected.event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      expect(header).toContainElement(source);

      const accepted = dispatchVersionDiffActionKey(
        source,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(destination).toHaveFocus();
    },
  );

  it("publishes prevention to a same-root ancestor after an exact delegated native delivery", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const ancestorAction = vi.fn();
    const ancestorDelivery = vi.fn(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!event.defaultPrevented || !event.isDefaultPrevented()) {
          ancestorAction();
        }
      },
    );
    const host = document.createElement("div");
    document.body.append(host);
    const fixture = { root: createRoot(host), host };
    versionDiffViews.push(fixture);
    act(() => {
      fixture.root.render(
        <StrictMode>
          <div onKeyDown={ancestorDelivery}>
            <VersionDiffView
              session={versionDiffSession("unused live text")}
              preview={versionDiffComparePreview()}
            />
          </div>
        </StrictMode>,
      );
    });
    fireEvent.click(versionDiffActions(host).next);
    const actions = versionDiffActions(host);
    const source = actions.previous;
    const destination = actions.next;
    const header = versionDiffRoot(host).firstElementChild as HTMLDivElement;
    const groupCapture = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(header, "onKeyDownCapture");
    const currentTarget = Object.getOwnPropertyDescriptor(
      Event.prototype,
      "currentTarget",
    )?.get;
    if (!currentTarget) throw new Error("Missing currentTarget getter");
    const delegatedTargets: EventTarget[] = [];
    const restore = replaceVersionDiffReactHandlers(header, {
      onKeyDownCapture: (event) => {
        const delegated = Reflect.apply(
          currentTarget,
          event.nativeEvent,
          [],
        ) as EventTarget | null;
        if (delegated) delegatedTargets.push(delegated);
        groupCapture(event);
      },
    });
    source.focus();
    preventDefault.mockClear();
    focus.mockClear();

    try {
      const result = dispatchVersionDiffActionKey(
        source,
        "ArrowRight",
        {},
        false,
      );

      expect(result.event.defaultPrevented).toBe(true);
      expect(delegatedTargets).toEqual([host]);
      expect(ancestorDelivery).toHaveBeenCalledOnce();
      expect(ancestorAction).not.toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(destination).toHaveFocus();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expectNoVersionDiffExternalWork();
    } finally {
      restore();
    }
  });

  it("requires the native listener's exact backing receiver and rejects a Window lookalike", () => {
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    const bridges = new WeakMap<EventListener, EventListener>();
    const lookalike = Object.create(
      Object.getPrototypeOf(window),
    ) as Window;
    Object.defineProperty(lookalike, "document", {
      configurable: true,
      value: document,
    });
    let useLookalike = true;
    vi.spyOn(window, "addEventListener").mockImplementation(
      (type, listener, options) => {
        if (type === "keydown" && typeof listener === "function") {
          const bridge: EventListener = function (this: Window, event) {
            Reflect.apply(
              listener,
              useLookalike ? lookalike : this,
              [event],
            );
          };
          bridges.set(listener, bridge);
          originalAdd(type, bridge, options);
          return;
        }
        originalAdd(type, listener, options);
      },
    );
    vi.spyOn(window, "removeEventListener").mockImplementation(
      (type, listener, options) => {
        const exact =
          type === "keydown" && typeof listener === "function"
            ? bridges.get(listener)
            : undefined;
        originalRemove(type, exact ?? listener, options);
      },
    );
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fixture = createVersionDiffView(
      versionDiffComparePreview(),
      "unused live text",
    );
    fireEvent.click(versionDiffActions(fixture.host).next);
    const actions = versionDiffActions(fixture.host);
    const source = actions.previous;
    const destination = actions.next;
    source.focus();
    preventDefault.mockClear();
    focus.mockClear();

    const rejected = dispatchVersionDiffActionKey(
      source,
      "ArrowRight",
      {},
      false,
    );
    expect(rejected.event.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(source).toHaveFocus();
    expect(lookalike.document).toBe(document);

    useLookalike = false;
    const accepted = dispatchVersionDiffActionKey(
      source,
      "ArrowRight",
      {},
      false,
    );
    expect(accepted.event.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(destination).toHaveFocus();
  });

  it("accepts an owner defaultView facade with its exact proven backing Window", () => {
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    const facadeAdd: Window["addEventListener"] = function (
      this: Window,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      originalAdd(type, listener, options);
    } as Window["addEventListener"];
    const facadeRemove: Window["removeEventListener"] = function (
      this: Window,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      originalRemove(type, listener, options);
    } as Window["removeEventListener"];
    let facade!: Window & typeof globalThis;
    facade = new Proxy(window as Window & typeof globalThis, {
      get(target, property) {
        if (property === "addEventListener") return facadeAdd;
        if (property === "removeEventListener") return facadeRemove;
        if (property === "window" || property === "self") return facade;
        return Reflect.get(target, property, target);
      },
    });
    const defaultView = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "defaultView",
    )?.get;
    if (!defaultView) throw new Error("Missing defaultView getter");
    vi.spyOn(Document.prototype, "defaultView", "get").mockImplementation(
      function (this: Document) {
        const actual = Reflect.apply(defaultView, this, []) as Window | null;
        return this === document ? facade : actual;
      },
    );
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fixture = createVersionDiffView(
      versionDiffComparePreview(),
      "unused live text",
    );
    fireEvent.click(versionDiffActions(fixture.host).next);
    const actions = versionDiffActions(fixture.host);
    actions.previous.focus();
    preventDefault.mockClear();
    focus.mockClear();

    const accepted = dispatchVersionDiffActionKey(
      actions.previous,
      "ArrowRight",
      {},
      false,
    );

    expect(accepted.event.view).toBe(facade);
    expect(accepted.event.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(actions.next).toHaveFocus();
  });

  it("rejects restored action DOM history and recovers through a fresh comparison", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preview = versionDiffComparePreview();
    const fixture = createVersionDiffView(preview, "unused live text");
    fireEvent.click(versionDiffActions(fixture.host).next);
    let actions = versionDiffActions(fixture.host);
    const parent = actions.previous.parentNode!;
    const nextSibling = actions.previous.nextSibling;
    parent.append(actions.previous);
    parent.insertBefore(actions.previous, nextSibling);
    actions.previous.focus();
    preventDefault.mockClear();
    focus.mockClear();

    const rejected = dispatchVersionDiffActionKey(
      actions.previous,
      "ArrowRight",
      {},
      false,
    );
    expect(rejected.event.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    renderVersionDiffView(
      fixture,
      preview,
      "unused live text",
      "fresh-actions",
    );
    fireEvent.click(versionDiffActions(fixture.host).next);
    actions = versionDiffActions(fixture.host);
    actions.previous.focus();
    preventDefault.mockClear();
    focus.mockClear();
    const accepted = dispatchVersionDiffActionKey(
      actions.previous,
      "ArrowRight",
      {},
      false,
    );
    expect(accepted.event.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(actions.next).toHaveFocus();
  });

  it("rejects partial action-ref replay, stale handlers, and cleaned-up publications", async () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preview = versionDiffComparePreview();
    const fixture = createVersionDiffView(preview, "unused live text");
    fireEvent.click(versionDiffActions(fixture.host).next);
    let actions = versionDiffActions(fixture.host);
    const source = actions.previous;
    const ref = versionDiffRef(source);
    const staleCapture = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(source, "onKeyDownCapture");
    const staleBubble = versionDiffReactHandler<
      (event: DeliveredVersionDiffActionKey) => void
    >(source, "onKeyDown");
    act(() => {
      ref(null);
      ref(source);
    });
    source.focus();
    preventDefault.mockClear();
    focus.mockClear();
    const replayed = dispatchVersionDiffActionKey(
      source,
      "ArrowRight",
      {},
      false,
    );
    expect(replayed.event.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    renderVersionDiffView(
      fixture,
      preview,
      "unused live text",
      "fresh-ref",
    );
    fireEvent.click(versionDiffActions(fixture.host).next);
    actions = versionDiffActions(fixture.host);
    actions.previous.focus();
    preventDefault.mockClear();
    focus.mockClear();
    const fresh = dispatchVersionDiffActionKey(
      actions.previous,
      "ArrowRight",
      {},
      false,
    );
    expect(fresh.event.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledOnce();

    await act(async () => fixture.root.unmount());
    const fixtureIndex = versionDiffViews.indexOf(fixture);
    if (fixtureIndex >= 0) versionDiffViews.splice(fixtureIndex, 1);
    const fabricated = {
      nativeEvent: createVersionDiffActionKey(source, "ArrowRight"),
    } as unknown as DeliveredVersionDiffActionKey;
    expect(() => {
      staleCapture(fabricated);
      staleBubble(fabricated);
    }).not.toThrow();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    fixture.host.remove();
  });

  it("preserves Tab, pointer, Enter, Space, and bracket activation behavior", async () => {
    const user = userEvent.setup();
    const fixture = createVersionDiffView(
      versionDiffComparePreview(),
      "unused live text",
    );
    let actions = versionDiffActions(fixture.host);
    const header = within(fixture.host).getByTestId("diff-header");
    const initialHeader = header.textContent;

    await user.click(actions.swap!);
    expect(header.textContent).not.toBe(initialHeader);
    await user.keyboard("{Enter}");
    expect(header.textContent).toBe(initialHeader);
    await user.keyboard(" ");
    expect(header.textContent).not.toBe(initialHeader);

    actions = versionDiffActions(fixture.host);
    await user.click(actions.next);
    actions = versionDiffActions(fixture.host);
    actions.swap!.focus();
    const tab = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      code: "Tab",
    });
    trustKeyboardEvent(tab, window);
    let tabAllowed = false;
    act(() => {
      tabAllowed = actions.swap!.dispatchEvent(tab);
    });
    expect(tabAllowed).toBe(true);
    expect(tab.defaultPrevented).toBe(false);

    fireEvent.keyDown(actions.previous, { key: "]" });
    expect(within(fixture.host).getByTestId("diff-counter")).toHaveTextContent(
      "3 of 3 changes",
    );
    actions = versionDiffActions(fixture.host);
    fireEvent.keyDown(actions.next, { key: "[" });
    expect(within(fixture.host).getByTestId("diff-counter")).toHaveTextContent(
      "2 of 3 changes",
    );
    expectNoVersionDiffExternalWork();
  });
});

describe("VersionDiffView · direct-root Strict Mode Home/End authority", () => {
  let originalScrollIntoView: PropertyDescriptor | undefined;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let reveals: Array<{
    element: Element;
    options: ScrollIntoViewOptions | undefined;
  }>;

  beforeEach(() => {
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    reveals = [];
    scrollIntoView = vi.fn(function (
      this: Element,
      options?: ScrollIntoViewOptions,
    ) {
      reveals.push({ element: this, options });
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
  });

  afterEach(async () => {
    while (versionDiffViews.length > 0) {
      const fixture = versionDiffViews.pop()!;
      await act(async () => fixture.root.unmount());
      fixture.host.remove();
    }
    if (originalScrollIntoView) {
      Object.defineProperty(
        Element.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  it.each([
    [0, "Home", 0, false],
    [0, "End", 2, true],
    [1, "Home", 0, true],
    [1, "End", 2, true],
    [2, "Home", 0, true],
    [2, "End", 2, false],
  ] as const)(
    "moves from hunk %i with %s to exact hunk %i",
    (sourceIndex, key, destinationIndex, shouldReveal) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const fixture = createVersionDiffView();
      const root = versionDiffRoot(fixture.host);
      const controls = within(fixture.host);
      for (let index = 0; index < sourceIndex; index++) {
        fireEvent.click(controls.getByTestId("diff-next"));
      }
      expect(controls.getByTestId("diff-counter")).toHaveTextContent(
        `${sourceIndex + 1} of 3 changes`,
      );
      preventDefault.mockClear();
      scrollIntoView.mockClear();
      reveals.length = 0;

      const result = dispatchVersionDiffKey(root, key);

      expect(result.allowed).toBe(false);
      expect(result.event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(controls.getByTestId("diff-counter")).toHaveTextContent(
        `${destinationIndex + 1} of 3 changes`,
      );
      expect(
        controls.getByTestId(`diff-hunk-${destinationIndex + 1}`),
      ).toHaveAttribute("data-active", "true");
      if (shouldReveal) {
        expect(scrollIntoView).toHaveBeenCalledOnce();
        expect(reveals).toEqual([
          {
            element: controls.getByTestId(
              `diff-hunk-${destinationIndex + 1}`,
            ),
            options: { block: "center" },
          },
        ]);
      } else {
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(reveals).toEqual([]);
      }
      expectNoVersionDiffExternalWork();
    },
  );

  it("retains bracket shortcuts and previous/next buttons without external work", () => {
    const fixture = createVersionDiffView();
    const root = versionDiffRoot(fixture.host);
    const controls = within(fixture.host);
    scrollIntoView.mockClear();
    reveals.length = 0;

    fireEvent.keyDown(root, { key: "]" });
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "2 of 3 changes",
    );
    fireEvent.click(controls.getByTestId("diff-next"));
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "3 of 3 changes",
    );
    fireEvent.click(controls.getByTestId("diff-prev"));
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "2 of 3 changes",
    );
    fireEvent.keyDown(root, { key: "[" });
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "1 of 3 changes",
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(4);
    expect(
      reveals.every(({ options }) => options?.block === "center"),
    ).toBe(true);
    expectNoVersionDiffExternalWork();
  });

  it.each([
    "input",
    "button",
    "a",
    "select",
    "textarea",
    "editable",
    "outside",
  ] as const)(
    "preserves native Home/End behavior for %s targets",
    (targetKind) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const fixture = createVersionDiffView();
      const root = versionDiffRoot(fixture.host);
      const controls = within(fixture.host);
      fireEvent.click(controls.getByTestId("diff-next"));
      preventDefault.mockClear();
      scrollIntoView.mockClear();
      reveals.length = 0;

      let target: HTMLElement;
      if (targetKind === "editable") {
        target = document.createElement("div");
        target.contentEditable = "true";
      } else if (targetKind === "outside") {
        target = document.createElement("button");
      } else {
        target = document.createElement(targetKind);
      }
      target.tabIndex = 0;
      if (targetKind === "outside") document.body.append(target);
      else root.append(target);

      const result = dispatchVersionDiffKey(target, "End");

      expect(result.allowed).toBe(true);
      expect(result.event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(controls.getByTestId("diff-counter")).toHaveTextContent(
        "2 of 3 changes",
      );
      expect(document.activeElement).toBe(target);
      expectNoVersionDiffExternalWork();
      target.remove();
    },
  );

  it.each([
    ["Control", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["repeat", { repeat: true }],
    ["composition", { isComposing: true }],
    ["non-bubbling", { bubbles: false }],
    ["non-cancelable", { cancelable: false }],
  ] as const)("rejects %s without claiming or preventing", (_name, init) => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const fixture = createVersionDiffView();
    const root = versionDiffRoot(fixture.host);
    const controls = within(fixture.host);
    preventDefault.mockClear();

    const first = dispatchVersionDiffKey(root, "End", init);
    expect(first.event.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "1 of 3 changes",
    );

    const successor = dispatchVersionDiffKey(root, "End");
    expect(successor.allowed).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "3 of 3 changes",
    );
    expectNoVersionDiffExternalWork();
  });

  it("rejects untrusted, pre-canceled, propagation-stopped, and fabricated events", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const fixture = createVersionDiffView();
    const root = versionDiffRoot(fixture.host);
    const controls = within(fixture.host);
    root.focus();
    preventDefault.mockClear();

    const synthetic = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "End",
    });
    act(() => {
      expect(root.dispatchEvent(synthetic)).toBe(true);
    });
    expect(synthetic.isTrusted).toBe(false);

    const canceled = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "End",
    });
    trustKeyboardEvent(canceled, window);
    canceled.preventDefault();
    preventDefault.mockClear();
    act(() => {
      expect(root.dispatchEvent(canceled)).toBe(false);
    });

    const stop = (event: Event) => event.stopPropagation();
    root.addEventListener("keydown", stop, { capture: true, once: true });
    dispatchVersionDiffKey(root, "End");

    const handler = versionDiffKeyHandler(root);
    expect(() =>
      handler({
        type: "keydown",
        key: "End",
        target: root,
        currentTarget: root,
        nativeEvent: Object.create(KeyboardEvent.prototype),
        bubbles: true,
        cancelable: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        defaultPrevented: false,
        isDefaultPrevented: () => false,
        isPropagationStopped: () => false,
        persist: vi.fn(),
      } as unknown as ReactKeyboardEvent<HTMLDivElement>),
    ).not.toThrow();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "1 of 3 changes",
    );
    expectNoVersionDiffExternalWork();
  });

  it("rejects foreign and crossed native events without consuming the current publication", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const fixture = createVersionDiffView();
    const root = versionDiffRoot(fixture.host);
    const controls = within(fixture.host);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignWindow = iframe.contentWindow as
      | (Window & typeof globalThis)
      | null;
    if (!foreignWindow) throw new Error("Foreign keyboard realm was unavailable");
    root.focus();
    preventDefault.mockClear();

    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "End",
    });
    trustKeyboardEvent(foreign, foreignWindow);
    act(() => {
      expect(root.dispatchEvent(foreign)).toBe(true);
    });
    iframe.remove();

    const restore = interceptVersionDiffKey(root, (current, event) => {
      const crossed = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "End",
      });
      trustKeyboardEvent(crossed, window);
      Object.defineProperty(event, "nativeEvent", {
        configurable: true,
        value: crossed,
      });
      current(event);
    });
    dispatchVersionDiffKey(root, "End");
    restore();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "1 of 3 changes",
    );

    dispatchVersionDiffKey(root, "End");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "3 of 3 changes",
    );
    expectNoVersionDiffExternalWork();
  });

  it("rejects stale and replayed handlers before one exact current event", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const fixture = createVersionDiffView();
    const root = versionDiffRoot(fixture.host);
    const controls = within(fixture.host);
    const stale = versionDiffKeyHandler(root);
    fireEvent.click(controls.getByTestId("diff-next"));
    const restore = interceptVersionDiffKey(
      root,
      (current, event) => {
        stale(event);
        current(event);
        current(event);
      },
    );
    preventDefault.mockClear();
    scrollIntoView.mockClear();
    reveals.length = 0;

    dispatchVersionDiffKey(root, "Home");
    restore();

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(reveals[0]?.element).toBe(controls.getByTestId("diff-hunk-1"));
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "1 of 3 changes",
    );
    expectNoVersionDiffExternalWork();
  });

  it.each([
    ["root attribute", (root: HTMLDivElement) => {
      const className = root.className;
      root.className = `${className} changed`;
      root.className = className;
    }],
    ["root placement", (root: HTMLDivElement) => {
      const parent = root.parentNode!;
      const next = root.nextSibling;
      root.remove();
      parent.insertBefore(root, next);
    }],
    ["hunk order", (_root: HTMLDivElement, host: HTMLElement) => {
      const first = within(host).getByTestId("diff-hunk-1");
      const parent = first.parentNode!;
      const next = first.nextSibling;
      parent.append(first);
      parent.insertBefore(first, next);
    }],
    ["hunk replacement", (_root: HTMLDivElement, host: HTMLElement) => {
      const first = within(host).getByTestId("diff-hunk-1");
      const replacement = first.cloneNode(true);
      first.replaceWith(replacement);
      replacement.parentNode?.replaceChild(first, replacement);
    }],
  ] as const)(
    "keeps restored %s history inert and accepts a fresh keyed successor",
    (_name, tamper) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const preview = versionDiffPreview();
      const fixture = createVersionDiffView(preview);
      let root = versionDiffRoot(fixture.host);
      const controls = within(fixture.host);
      fireEvent.click(controls.getByTestId("diff-next"));
      preventDefault.mockClear();
      scrollIntoView.mockClear();
      reveals.length = 0;

      tamper(root, fixture.host);
      const rejected = dispatchVersionDiffKey(root, "End");
      expect(rejected.allowed).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(controls.getByTestId("diff-counter")).toHaveTextContent(
        "2 of 3 changes",
      );

      renderVersionDiffView(
        fixture,
        preview,
        VERSION_DIFF_CURRENT,
        `fresh-${_name}`,
      );
      root = versionDiffRoot(fixture.host);
      preventDefault.mockClear();
      scrollIntoView.mockClear();
      reveals.length = 0;
      const accepted = dispatchVersionDiffKey(root, "End");

      expect(accepted.allowed).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(controls.getByTestId("diff-counter")).toHaveTextContent(
        "3 of 3 changes",
      );
      expectNoVersionDiffExternalWork();
    },
  );

  it("binds range facts and recovers only through a fresh comparison", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const newer = {
      ...named,
      id: "range-newer",
      number: 3,
      title: "Range newer",
    };
    const older = {
      ...named,
      id: "range-older",
      number: 1,
      title: "Range older",
    };
    const rangeMiddle = {
      ...named,
      id: "range-middle",
      number: 2,
      title: "Range middle",
    };
    const preview = {
      version: newer,
      content: VERSION_DIFF_CURRENT,
      base: { version: older, content: VERSION_DIFF_OLD },
      range: [newer, rangeMiddle],
    };
    const fixture = createVersionDiffView(
      preview,
      "unused live document text",
    );
    let root = versionDiffRoot(fixture.host);
    const controls = within(fixture.host);
    preventDefault.mockClear();
    rangeMiddle.title = "Mutated range";

    const rejected = dispatchVersionDiffKey(root, "End");
    expect(rejected.allowed).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "1 of 3 changes",
    );

    rangeMiddle.title = "Range middle";
    renderVersionDiffView(
      fixture,
      preview,
      "unused live document text",
      "fresh-range",
    );
    root = versionDiffRoot(fixture.host);
    preventDefault.mockClear();
    const accepted = dispatchVersionDiffKey(root, "End");
    expect(accepted.allowed).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(controls.getByTestId("diff-counter")).toHaveTextContent(
      "3 of 3 changes",
    );
    expectNoVersionDiffExternalWork();
  });

  it("rejects partial ref replay and accepts a complete current generation", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const preview = versionDiffPreview();
    const fixture = createVersionDiffView(preview);
    let root = versionDiffRoot(fixture.host);
    const firstHunk = within(fixture.host).getByTestId("diff-hunk-1");
    const ref = versionDiffRef(firstHunk);
    act(() => {
      ref(null);
      ref(firstHunk);
    });
    preventDefault.mockClear();

    const rejected = dispatchVersionDiffKey(root, "End");
    expect(rejected.allowed).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    renderVersionDiffView(fixture, preview);
    root = versionDiffRoot(fixture.host);
    preventDefault.mockClear();
    const accepted = dispatchVersionDiffKey(root, "End");
    expect(accepted.allowed).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(
      within(fixture.host).getByTestId("diff-counter"),
    ).toHaveTextContent("3 of 3 changes");
    expectNoVersionDiffExternalWork();
  });

  it("releases mutation custody on cleanup and leaves retained handlers inert", async () => {
    const NativeMutationObserver = window.MutationObserver;
    const activeObservers = new Set<MutationObserver>();
    class TrackingMutationObserver extends NativeMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        activeObservers.add(this);
      }

      override disconnect() {
        activeObservers.delete(this);
        super.disconnect();
      }
    }
    window.MutationObserver = TrackingMutationObserver;
    const fixture = createVersionDiffView();
    const root = versionDiffRoot(fixture.host);
    const stale = versionDiffKeyHandler(root);
    expect(activeObservers.size).toBe(1);

    try {
      await act(async () => {
        fixture.root.unmount();
        await Promise.resolve();
      });
      const index = versionDiffViews.indexOf(fixture);
      if (index >= 0) versionDiffViews.splice(index, 1);
      expect(activeObservers.size).toBe(0);

      const preventDefault = vi.fn();
      stale({
        currentTarget: root,
        target: root,
        key: "End",
        preventDefault,
        nativeEvent: createVersionDiffKey(root, "End"),
      } as unknown as ReactKeyboardEvent<HTMLDivElement>);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expectNoVersionDiffExternalWork();
    } finally {
      window.MutationObserver = NativeMutationObserver;
      fixture.host.remove();
    }
  });
});

describe("VersionsPanel · exact panel publications", () => {
  it("gives Close to a fresh publication after direct-root Strict Mode replay", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    let retiredClose:
      | ((event: CapturedEvent<HTMLButtonElement>) => void)
      | undefined;

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <VersionsBoundary
              session={session("strict-close")}
              onClose={onClose}
              onPreview={vi.fn()}
              boundary={1}
              onBoundary={() => {
                retiredClose ??= capturedProps(
                  host.querySelector<HTMLButtonElement>(
                    '[aria-label="Close version history"]',
                  )!,
                ).onClick;
              }}
            />
          </StrictMode>,
        );
      });
      const currentButton = host.querySelector<HTMLButtonElement>(
        '[aria-label="Close version history"]',
      )!;
      const currentClose = capturedProps(currentButton).onClick;
      expect(currentClose).not.toBe(retiredClose);

      const restore = interceptClick(currentButton, (original, event) => {
        retiredClose?.(event);
        original(event);
        original(event);
      });
      act(() => currentButton.click());
      restore();

      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["sibling row", "foreign connected", "detached source", "replacement source"] as const)(
    "rejects a %s Select source without consuming the exact current activation",
    async (sourceKind) => {
      const docId = `publication-source-${sourceKind.replaceAll(" ", "-")}`;
      const first = { ...named, id: `${docId}-first`, number: 2, title: "Publication first" };
      const second = { ...named, id: `${docId}-second`, number: 1, title: "Publication second" };
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      const onPreview = vi.fn();
      versions.mockResolvedValueOnce({ versions: [first, second] });
      version.mockImplementation(async (_docId: string, versionId: string) => ({
        version: { ...(versionId === first.id ? first : second), content: `# ${versionId}` },
      }));

      try {
        await act(async () => {
          root.render(
            <VersionsPanel
              session={session(docId)}
              onClose={vi.fn()}
              onPreview={onPreview}
              refreshKey={0}
            />,
          );
        });
        const panel = host.querySelector<HTMLElement>('[data-testid="versions-panel"]')!;
        const items = host.querySelectorAll<HTMLElement>('[data-testid="version-item"]');
        const exact = items[0].querySelector<HTMLButtonElement>("button")!;
        const sibling = items[1].querySelector<HTMLButtonElement>("button")!;
        const exactHandler = capturedProps(exact).onClick;
        let wrong = sibling;
        let restoreDom = () => {};
        let removeWrong = () => {};
        focusOwner.focus();

        if (sourceKind === "foreign connected") {
          wrong = document.createElement("button");
          document.body.append(wrong);
          removeWrong = () => wrong.remove();
        } else if (sourceKind === "detached source") {
          const parent = exact.parentElement!;
          exact.remove();
          wrong = exact;
          restoreDom = () => parent.append(exact);
        } else if (sourceKind === "replacement source") {
          const parent = exact.parentElement!;
          wrong = document.createElement("button");
          parent.replaceChild(wrong, exact);
          restoreDom = () => parent.replaceChild(exact, wrong);
        }

        expectInert(exactHandler, wrong, panel);
        if (sourceKind === "sibling row") {
          expectInert(capturedProps(sibling).onClick, exact, panel);
        }
        expect(version).not.toHaveBeenCalled();
        expect(onPreview).not.toHaveBeenCalled();

        restoreDom();
        let currentExact = exact;
        if (sourceKind === "detached source" || sourceKind === "replacement source") {
          await act(async () => {
            root.render(
              <VersionsPanel
                session={session(docId)}
                onClose={vi.fn()}
                onPreview={onPreview}
                refreshKey={0}
              />,
            );
          });
          currentExact = host
            .querySelectorAll<HTMLElement>('[data-testid="version-item"]')[0]
            .querySelector<HTMLButtonElement>("button")!;
        }
        fireEvent.click(currentExact);
        await act(async () => {});

        expect(version).toHaveBeenCalledOnce();
        expect(version).toHaveBeenCalledWith(docId, first.id);
        expect(onPreview).toHaveBeenCalledOnce();
        expect(onPreview).toHaveBeenCalledWith({ version: first, content: `# ${first.id}` });
        expect(document.activeElement).toBe(focusOwner);
        removeWrong();
      } finally {
        await act(async () => root.unmount());
        focusOwner.remove();
        host.remove();
      }
    },
  );

  it("retires every retained control before a same-document authority reaches its parent layout boundary", async () => {
    const docId = "publication-authority-boundary";
    const firstSession = session(docId);
    const nextSession = session(docId);
    const first = { ...named, id: `${docId}-first`, number: 2, title: "Boundary first" };
    const second = { ...named, id: `${docId}-second`, number: 1, title: "Boundary second" };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const firstClose = vi.fn();
    const nextClose = vi.fn();
    const firstPreview = vi.fn();
    const nextPreview = vi.fn();
    const nextPush = vi.fn();
    const nextRouter = { ...router, push: nextPush };
    const copyRequest = deferred<{ id: string; title: string }>();
    versions.mockReset()
      .mockResolvedValueOnce({ versions: [first, second] })
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce({ versions: [first, second] });
    copyVersion.mockReturnValueOnce(copyRequest.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    try {
      await act(async () => {
        root.render(
          <VersionsBoundary
            session={firstSession}
            onClose={firstClose}
            onPreview={firstPreview}
          />,
        );
      });
      const firstItem = host.querySelectorAll<HTMLElement>('[data-testid="version-item"]')[0];
      fireEvent.click(firstItem.querySelector<HTMLButtonElement>("button")!);
      await waitFor(() => expect(firstPreview).toHaveBeenCalledOnce());
      fireEvent.click(host.querySelector<HTMLInputElement>('[aria-label="Compare v1"]')!);
      fireEvent.click(host.querySelector<HTMLButtonElement>('[data-testid="version-rename"]')!);
      await act(async () => {
        root.render(
          <VersionsBoundary
            session={firstSession}
            onClose={firstClose}
            onPreview={firstPreview}
            refreshKey={1}
          />,
        );
      });
      expect(host.querySelector('[role="alert"]')).toHaveTextContent("refresh failed");

      const panel = host.querySelector<HTMLElement>('[data-testid="versions-panel"]')!;
      const row = host.querySelectorAll<HTMLElement>('[data-testid="version-item"]')[0];
      const staleClose = capturedProps(host.querySelector<HTMLButtonElement>('[aria-label="Close version history"]')!).onClick;
      const staleRetry = capturedProps(host.querySelector<HTMLButtonElement>("button.btn-outline")!).onClick;
      const staleClear = capturedProps(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Clear")!).onClick;
      const staleSelect = capturedProps(row.querySelector<HTMLButtonElement>("button")!).onClick;
      const staleCheckbox = capturedProps(row.querySelector<HTMLInputElement>('[data-testid="version-compare"]')!).onChange;
      const staleRestore = capturedProps(row.querySelector<HTMLButtonElement>('[data-testid="version-restore"]')!).onClick;
      const staleStartRename = capturedProps(row.querySelector<HTMLButtonElement>('[data-testid="version-rename"]')!).onClick;
      const staleCopy = capturedProps(row.querySelector<HTMLButtonElement>('[data-testid="version-copy"]')!).onClick;
      const oldInput = row.querySelector<HTMLInputElement>('[data-testid="version-rename-input"]')!;
      const staleInput = capturedProps(oldInput);
      firstClose.mockClear();
      firstPreview.mockClear();
      version.mockClear();
      versions.mockClear();
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      activeRouter = nextRouter;

      root.render(
        <VersionsBoundary
          session={nextSession}
          onClose={nextClose}
          onPreview={nextPreview}
          refreshKey={1}
          boundary={1}
          onBoundary={() => {
            const currentPanel = host.querySelector<HTMLElement>('[data-testid="versions-panel"]')!;
            const currentRow = host.querySelectorAll<HTMLElement>('[data-testid="version-item"]')[0];
            const currentClose = host.querySelector<HTMLButtonElement>('[aria-label="Close version history"]')!;
            const currentRetry = host.querySelector<HTMLButtonElement>("button.btn-outline")!;
            const currentClear = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Clear")!;
            const currentSelect = currentRow.querySelector<HTMLButtonElement>("button")!;
            const currentCheckbox = currentRow.querySelector<HTMLInputElement>('[data-testid="version-compare"]')!;
            const currentRestore = currentRow.querySelector<HTMLButtonElement>('[data-testid="version-restore"]')!;
            const currentRename = currentRow.querySelector<HTMLButtonElement>('[data-testid="version-rename"]')!;
            const currentCopy = currentRow.querySelector<HTMLButtonElement>('[data-testid="version-copy"]')!;
            const currentInput = currentRow.querySelector<HTMLInputElement>('[data-testid="version-rename-input"]')!;

            expect(currentPanel).toBe(panel);
            for (const [handler, source] of [
              [staleClose, currentClose],
              [staleRetry, currentRetry],
              [staleClear, currentClear],
              [staleSelect, currentSelect],
              [staleRestore, currentRestore],
              [staleStartRename, currentRename],
              [staleCopy, currentCopy],
            ] as const) {
              expectInert(handler, source, currentPanel);
            }
            expectInert(staleCheckbox, currentCheckbox, currentPanel);
            currentInput.value = "Retired draft";
            expectInert(staleInput.onChange, currentInput, currentPanel);
            expectInert(staleInput.onBlur, currentInput, currentPanel);
            expectInert(staleInput.onKeyDown, currentInput, currentPanel, "Enter");
            expectInert(staleInput.onKeyDown, currentInput, currentPanel, "Escape");
            expectInert(staleInput.onClick, currentInput, currentPanel);
            currentInput.value = "Boundary first";

            expect(window.confirm).not.toHaveBeenCalled();
            expect(versions).not.toHaveBeenCalled();
            expect(version).not.toHaveBeenCalled();
            expect(renameVersion).not.toHaveBeenCalled();
            expect(restoreVersion).not.toHaveBeenCalled();
            expect(copyVersion).not.toHaveBeenCalled();
            expect(firstClose).not.toHaveBeenCalled();
            expect(nextClose).not.toHaveBeenCalled();
            expect(firstPreview).not.toHaveBeenCalled();
            expect(nextPreview).not.toHaveBeenCalled();
            expect(pendingNotice).not.toHaveBeenCalled();
            expect(push).not.toHaveBeenCalled();
            expect(nextPush).not.toHaveBeenCalled();

            currentCopy.click();
            currentCopy.click();
            expect(copyVersion).toHaveBeenCalledOnce();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      copyRequest.resolve({ id: "boundary-copy", title: "Boundary copy" });
      await waitFor(() => expect(nextPush).toHaveBeenCalledOnce());

      expect(firstClose).not.toHaveBeenCalled();
      expect(firstPreview).not.toHaveBeenCalled();
      expect(nextPreview).not.toHaveBeenCalled();
      expect(pendingNotice).toHaveBeenCalledOnce();
      expect(nextPush).toHaveBeenCalledWith("/d/boundary-copy");
      expect(push).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps a replacement mount active when retained handlers and ref cleanup target the retired mount", async () => {
    const docId = "publication-remount";
    const current = { ...named, id: `${docId}-version`, title: "Remount version" };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    versions.mockResolvedValue({ versions: [current] });

    try {
      await act(async () => {
        root.render(
          <VersionsBoundary
            session={session(docId)}
            onClose={staleClose}
            onPreview={vi.fn()}
            mountKey="first"
          />,
        );
      });
      const oldPanel = host.querySelector<HTMLElement>('[data-testid="versions-panel"]')!;
      const oldButton = host.querySelector<HTMLButtonElement>('[aria-label="Close version history"]')!;
      const oldHandler = capturedProps(oldButton).onClick;
      const oldRef = capturedProps(oldPanel).ref;
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });

      root.render(
        <VersionsBoundary
          session={session(docId)}
          onClose={currentClose}
          onPreview={vi.fn()}
          mountKey="second"
          boundary={1}
          onBoundary={() => {
            const newPanel = host.querySelector<HTMLElement>('[data-testid="versions-panel"]')!;
            const newButton = host.querySelector<HTMLButtonElement>('[aria-label="Close version history"]')!;
            const newHandler = capturedProps(newButton).onClick;
            expect(newPanel).not.toBe(oldPanel);
            expect(newButton).not.toBe(oldButton);

            expectInert(oldHandler, newButton, newPanel);
            expectInert(newHandler, oldButton, newPanel);
            oldRef?.(null);
            newButton.click();
            newButton.click();
            expect(staleClose).not.toHaveBeenCalled();
            expect(currentClose).toHaveBeenCalledOnce();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rechecks Restore after confirmation before starting its request", async () => {
    const docId = "publication-restore-confirmation";
    const current = { ...named, id: `${docId}-version`, title: "Confirmation version" };
    versions.mockResolvedValueOnce({ versions: [current] });
    render(
      <VersionsPanel
        session={session(docId)}
        onClose={vi.fn()}
        onPreview={vi.fn()}
        refreshKey={0}
      />,
    );
    fireEvent.click(await screen.findByText("Confirmation version"));
    const restore = screen.getByTestId("version-restore");
    vi.spyOn(window, "confirm").mockImplementation(() => {
      current.title = "Changed during confirmation";
      return true;
    });

    fireEvent.click(restore);
    current.title = "Confirmation version";

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(restoreVersion).not.toHaveBeenCalled();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("drops a same-document Copy settlement at the replacement layout boundary and leaves the replacement usable", async () => {
    const docId = "publication-copy-settlement";
    const current = { ...named, id: `${docId}-version`, title: "Settlement version" };
    const staleCopy = deferred<{ id: string; title: string }>();
    const currentCopy = deferred<{ id: string; title: string }>();
    const stalePreview = vi.fn();
    const nextPreview = vi.fn();
    const nextPush = vi.fn();
    const nextRouter = { ...router, push: nextPush };
    versions.mockResolvedValue({ versions: [current] });
    copyVersion.mockReturnValueOnce(staleCopy.promise).mockReturnValueOnce(currentCopy.promise);
    const rendered = render(
      <VersionsBoundary
        session={session(docId)}
        onClose={vi.fn()}
        onPreview={stalePreview}
      />,
    );
    fireEvent.click(await screen.findByText("Settlement version"));
    await waitFor(() => expect(stalePreview).toHaveBeenCalledOnce());
    stalePreview.mockClear();
    fireEvent.click(screen.getByTestId("version-copy"));
    expect(copyVersion).toHaveBeenCalledOnce();
    activeRouter = nextRouter;

    rendered.rerender(
      <>
        <VersionsBoundary
          session={session(docId)}
          onClose={vi.fn()}
          onPreview={nextPreview}
          boundary={1}
        />
        <SettleInLayout settle={() => staleCopy.resolve({ id: "retired-copy", title: "Retired copy" })} />
      </>,
    );
    await act(async () => {});

    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(nextPush).not.toHaveBeenCalled();
    expect(stalePreview).not.toHaveBeenCalled();
    expect(nextPreview).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(false);

    fireEvent.click(screen.getByTestId("version-copy"));
    fireEvent.click(screen.getByTestId("version-copy"));
    expect(copyVersion).toHaveBeenCalledTimes(2);
    currentCopy.resolve({ id: "current-copy", title: "Current copy" });
    await waitFor(() => expect(nextPush).toHaveBeenCalledOnce());
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(nextPush).toHaveBeenCalledWith("/d/current-copy");
  });
});

describe("VersionsPanel · direct-root Strict Mode authority", () => {
  it("accepts every exact React event family with a production-mangled constructor", async () => {
    const docId = "strict-minified-events";
    const newer = {
      ...named,
      id: `${docId}-newer`,
      number: 2,
      title: "Minified newer",
    };
    const older = {
      ...named,
      id: `${docId}-older`,
      number: 1,
      title: "Minified older",
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPreview = vi.fn();
    versions.mockResolvedValue({ versions: [newer, older] });
    version.mockImplementation(async (_docId: string, versionId: string) => ({
      version: {
        ...(versionId === newer.id ? newer : older),
        content: `# ${versionId}`,
      },
    }));
    renameVersion.mockResolvedValue({ ok: true });

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText(newer.title);

      let checkbox = host.querySelector<HTMLInputElement>(
        `[aria-label="Compare v${newer.number}"]`,
      )!;
      interceptMangledEvent(checkbox, "onChange");
      await act(async () => checkbox.click());
      expect(checkbox).toBeChecked();

      const select = (await screen.findByText(newer.title)).closest(
        "button",
      ) as HTMLButtonElement;
      interceptMangledEvent(select, "onClick");
      act(() => select.click());
      await waitFor(() =>
        expect(onPreview).toHaveBeenLastCalledWith({
          version: newer,
          content: `# ${newer.id}`,
        }),
      );

      let rename = await screen.findByTestId<HTMLButtonElement>(
        "version-rename",
      );
      interceptMangledEvent(rename, "onClick");
      act(() => rename.click());

      let input = screen.getByTestId<HTMLInputElement>(
        "version-rename-input",
      );
      interceptMangledEvent(input, "onChange");
      fireEvent.change(input, { target: { value: "Cancelled minified title" } });
      expect(input).toHaveValue("Cancelled minified title");

      input = screen.getByTestId<HTMLInputElement>("version-rename-input");
      interceptMangledEvent(input, "onKeyDown");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByTestId("version-rename-input")).toBeNull();

      rename = screen.getByTestId<HTMLButtonElement>("version-rename");
      fireEvent.click(rename);
      input = screen.getByTestId<HTMLInputElement>("version-rename-input");
      interceptMangledEvent(input, "onChange");
      fireEvent.change(input, { target: { value: "Final minified title" } });

      input = screen.getByTestId<HTMLInputElement>("version-rename-input");
      interceptMangledEvent(input, "onBlur");
      fireEvent.blur(input);
      await waitFor(() =>
        expect(renameVersion).toHaveBeenCalledExactlyOnceWith(
          docId,
          newer.id,
          "Final minified title",
        ),
      );

      checkbox = host.querySelector<HTMLInputElement>(
        `[aria-label="Compare v${newer.number}"]`,
      )!;
      expect(checkbox).toBeChecked();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects malformed React method fields without consuming the exact event", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session("strict-malformed-event"),
        onClose,
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      const close = host.querySelector<HTMLButtonElement>(
        '[aria-label="Close version history"]',
      )!;
      for (const field of [
        "isDefaultPrevented",
        "isPropagationStopped",
        "persist",
      ] as const) {
        const restore = interceptClick(close, (original, event) => {
          const overrides: Partial<
            ExactSyntheticEvent<HTMLButtonElement>
          > = {};
          overrides[field] = undefined;
          original(cloneSyntheticEvent(event, overrides));
        });
        act(() => close.click());
        restore();
        expect(onClose).not.toHaveBeenCalled();
      }

      act(() => close.click());
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects crossed native linkage without consuming the exact current action", async () => {
    const docId = "strict-crossed-native-event";
    const first = {
      ...named,
      id: `${docId}-first`,
      number: 2,
      title: "Crossed first",
    };
    const second = {
      ...named,
      id: `${docId}-second`,
      number: 1,
      title: "Crossed second",
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPreview = vi.fn();
    versions.mockResolvedValue({ versions: [first, second] });
    version.mockImplementation(async (_docId: string, versionId: string) => ({
      version: {
        ...(versionId === first.id ? first : second),
        content: `# ${versionId}`,
      },
    }));

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview,
        refreshKey: 0,
      });
      const firstControl = (await screen.findByText(first.title)).closest(
        "button",
      ) as HTMLButtonElement;
      const secondControl = (await screen.findByText(second.title)).closest(
        "button",
      ) as HTMLButtonElement;
      const firstHandler = capturedProps(firstControl).onClick!;
      const restore = interceptClick(secondControl, (_original, event) => {
        firstHandler(
          cloneSyntheticEvent(event, {
            currentTarget: firstControl,
            target: firstControl,
          }),
        );
      });

      act(() => secondControl.click());
      restore();
      expect(version).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();

      act(() => firstControl.click());
      await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
      expect(version).toHaveBeenCalledExactlyOnceWith(docId, first.id);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps Retry exact and one-use after a Strict Mode remount", async () => {
    const docId = "strict-retry";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      session: session(docId),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    };
    versions.mockReset().mockRejectedValue(new Error("strict list unavailable"));

    try {
      await renderStrictVersions(root, props, "A");
      const staleButton = await screen.findByRole<HTMLButtonElement>("button", {
        name: "Retry",
      });
      const staleRetry = capturedProps(staleButton).onClick;

      await renderStrictVersions(root, props, "B");
      const currentButton = await screen.findByRole<HTMLButtonElement>("button", {
        name: "Retry",
      });
      const callsBeforeRetry = versions.mock.calls.length;
      const restore = interceptClick(currentButton, (original, event) => {
        staleRetry?.(event);
        original(event);
        original(event);
      });
      act(() => currentButton.click());
      restore();

      await waitFor(() =>
        expect(versions).toHaveBeenCalledTimes(callsBeforeRetry + 1),
      );
      expect(host.querySelector('[role="alert"]')).toHaveTextContent(
        "strict list unavailable",
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps Select and preview exact across stale and consumed genuine events", async () => {
    const docId = "strict-select";
    const first = {
      ...named,
      id: `${docId}-first`,
      number: 2,
      title: "Strict select",
    };
    const second = {
      ...named,
      id: `${docId}-second`,
      number: 1,
      title: "Strict sibling",
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPreview = vi.fn();
    const props = {
      session: session(docId),
      onClose: vi.fn(),
      onPreview,
      refreshKey: 0,
    };
    versions.mockResolvedValue({ versions: [first, second] });
    version.mockImplementation(async (_docId: string, versionId: string) => ({
      version: {
        ...(versionId === first.id ? first : second),
        content: `# ${versionId}`,
      },
    }));

    try {
      await renderStrictVersions(root, props, "A");
      const staleButton = await screen.findByText(first.title);
      const staleSelect = capturedProps(
        staleButton.closest("button") as HTMLButtonElement,
      ).onClick;

      await renderStrictVersions(root, props, "B");
      const currentButton = (await screen.findByText(first.title)).closest(
        "button",
      ) as HTMLButtonElement;
      const restore = interceptClick(currentButton, (original, event) => {
        staleSelect?.(event);
        original(event);
        original(event);
      });
      act(() => currentButton.click());
      restore();

      await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
      expect(version).toHaveBeenCalledExactlyOnceWith(docId, first.id);
      expect(onPreview).toHaveBeenCalledWith({
        version: first,
        content: `# ${first.id}`,
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps Compare and Clear exact through controlled-input replay", async () => {
    const docId = "strict-compare";
    const newer = {
      ...named,
      id: `${docId}-newer`,
      number: 2,
      title: "Strict newer",
    };
    const older = {
      ...named,
      id: `${docId}-older`,
      number: 1,
      title: "Strict older",
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPreview = vi.fn();
    versions.mockResolvedValue({ versions: [newer, older] });
    version.mockImplementation(async (_docId: string, versionId: string) => ({
      version: {
        ...(versionId === newer.id ? newer : older),
        content: `# ${versionId}`,
      },
    }));

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText(newer.title);
      await act(async () => {});
      const [newerCheckbox, olderCheckbox] = Array.from(
        host.querySelectorAll<HTMLInputElement>('[data-testid="version-compare"]'),
      );
      for (const checkbox of [newerCheckbox, olderCheckbox]) {
        interceptEvent(checkbox, "onChange", (original, event) => {
          original(event);
          original(event);
        });
        await act(async () => checkbox.click());
      }

      expect(newerCheckbox).toBeChecked();
      expect(olderCheckbox).toBeChecked();
      await waitFor(() =>
        expect(onPreview).toHaveBeenLastCalledWith({
          version: newer,
          content: `# ${newer.id}`,
          base: { version: older, content: `# ${older.id}` },
          range: [newer],
        }),
      );

      onPreview.mockClear();
      const clear = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Clear",
      )!;
      const restore = interceptClick(clear, (original, event) => {
        original(event);
        original(event);
      });
      act(() => clear.click());
      restore();

      expect(newerCheckbox).not.toBeChecked();
      expect(olderCheckbox).not.toBeChecked();
      expect(onPreview).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps Restore exact before confirmation and reentrant request work", async () => {
    const docId = "strict-restore";
    const current = {
      ...named,
      id: `${docId}-version`,
      title: "Strict restore",
    };
    const request = deferred<{ ok: boolean }>();
    const reload = deferred<{ versions: VersionSummary[] }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    versions.mockReset()
      .mockResolvedValueOnce({ versions: [current] })
      .mockReturnValueOnce(reload.promise);
    let restoreButton!: HTMLButtonElement;
    restoreVersion.mockImplementationOnce(() => {
      restoreButton.click();
      return request.promise;
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      fireEvent.click(await screen.findByText(current.title));
      restoreButton = await screen.findByTestId("version-restore");
      const restore = interceptClick(restoreButton, (original, event) => {
        original(event);
        original(event);
      });
      act(() => restoreButton.click());
      restore();

      expect(confirm).toHaveBeenCalledOnce();
      expect(restoreVersion).toHaveBeenCalledExactlyOnceWith(docId, current.id);
      request.resolve({ ok: true });
      await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
      reload.resolve({ versions: [current] });
      await waitFor(() =>
        expect(screen.queryByTestId("version-restore")).toBeNull(),
      );
      expect(spinnerFor(current.title)).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps Rename change, cancel, submit, and blur exact after replay", async () => {
    const docId = "strict-rename";
    const current = {
      ...named,
      id: `${docId}-version`,
      title: "Strict rename",
    };
    const request = deferred<{ ok: boolean }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    versions.mockResolvedValue({ versions: [current] });
    renameVersion.mockReturnValueOnce(request.promise);

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      fireEvent.click(await screen.findByText(current.title));
      fireEvent.click(await screen.findByTestId("version-rename"));
      let input = screen.getByTestId<HTMLInputElement>("version-rename-input");
      fireEvent.change(input, { target: { value: "Cancelled title" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByTestId("version-rename-input")).toBeNull();
      expect(renameVersion).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("version-rename"));
      input = screen.getByTestId<HTMLInputElement>("version-rename-input");
      interceptEvent(input, "onChange", (original, event) => {
        original(event);
        original(event);
      });
      fireEvent.change(input, { target: { value: "  Final strict title  " } });
      interceptEvent(input, "onKeyDown", (original, event) => {
        original(event);
        original(event);
      });
      act(() => {
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.blur(input);
      });

      expect(renameVersion).toHaveBeenCalledExactlyOnceWith(
        docId,
        current.id,
        "Final strict title",
      );
      request.resolve({ ok: true });
      await act(async () => {});
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps Copy and navigation exact through synchronous reentry", async () => {
    const docId = "strict-copy";
    const current = {
      ...named,
      id: `${docId}-version`,
      title: "Strict copy",
    };
    const request = deferred<{ id: string; title: string }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    versions.mockResolvedValue({ versions: [current] });
    let copyButton!: HTMLButtonElement;
    copyVersion.mockImplementationOnce(() => {
      copyButton.click();
      return request.promise;
    });

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      fireEvent.click(await screen.findByText(current.title));
      copyButton = await screen.findByTestId("version-copy");
      const restore = interceptClick(copyButton, (original, event) => {
        original(event);
        original(event);
      });
      act(() => copyButton.click());
      restore();

      expect(copyVersion).toHaveBeenCalledExactlyOnceWith(docId, current.id);
      request.resolve({ id: "strict-copy-result", title: "Strict copy result" });
      await waitFor(() =>
        expect(push).toHaveBeenCalledExactlyOnceWith("/d/strict-copy-result"),
      );
      expect(pendingNotice).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["attribute", "descendant", "placement", "row order"] as const)(
    "permanently retires a Strict publication after restored %s mutation without poisoning a fresh mount",
    async (tamper) => {
      const docId = `strict-tamper-${tamper.replace(" ", "-")}`;
      const first = {
        ...named,
        id: `${docId}-first`,
        number: 2,
        title: "Tamper first",
      };
      const second = {
        ...named,
        id: `${docId}-second`,
        number: 1,
        title: "Tamper second",
      };
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onPreview = vi.fn();
      const props = {
        session: session(docId),
        onClose: vi.fn(),
        onPreview,
        refreshKey: 0,
      };
      versions.mockResolvedValue({ versions: [first, second] });
      version.mockResolvedValue({
        version: { ...first, content: "# tamper first" },
      });

      try {
        await renderStrictVersions(root, props, "A");
        const panel = host.querySelector<HTMLElement>(
          '[data-testid="versions-panel"]',
        )!;
        const firstButton = (await screen.findByText(first.title)).closest(
          "button",
        ) as HTMLButtonElement;
        const staleSelect = capturedProps(firstButton).onClick;
        const stalePanelRef = capturedProps(panel).ref;
        const list = firstButton.closest("ul")!;
        const firstItem = firstButton.closest("li")!;

        if (tamper === "attribute") {
          const className = panel.className;
          panel.className = `${className} altered`;
          panel.className = className;
        } else if (tamper === "descendant") {
          const text = firstButton.querySelector("span")!.firstChild!;
          const replacement = text.cloneNode(true);
          const parent = text.parentNode!;
          parent.replaceChild(replacement, text);
          parent.replaceChild(text, replacement);
        } else if (tamper === "placement") {
          const parent = panel.parentNode!;
          const nextSibling = panel.nextSibling;
          panel.remove();
          parent.insertBefore(panel, nextSibling);
        } else {
          const secondItem = list.children.item(1)!;
          list.insertBefore(secondItem, firstItem);
          list.insertBefore(firstItem, secondItem);
        }

        act(() => firstButton.click());
        expect(version).not.toHaveBeenCalled();
        expect(onPreview).not.toHaveBeenCalled();

        await renderStrictVersions(root, props, "B");
        const currentPanel = host.querySelector<HTMLElement>(
          '[data-testid="versions-panel"]',
        )!;
        const currentButton = (await screen.findByText(first.title)).closest(
          "button",
        ) as HTMLButtonElement;
        act(() => {
          stalePanelRef?.(currentPanel);
          stalePanelRef?.(null);
        });
        const restore = interceptClick(currentButton, (original, event) => {
          staleSelect?.(event);
          original(event);
          original(event);
        });
        act(() => currentButton.click());
        restore();

        await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
        expect(version).toHaveBeenCalledExactlyOnceWith(docId, first.id);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("isolates late Strict Copy settlement from the current mount", async () => {
    const docId = "strict-copy-settlement";
    const current = {
      ...named,
      id: `${docId}-version`,
      title: "Strict settlement",
    };
    const staleRequest = deferred<{ id: string; title: string }>();
    const currentRequest = deferred<{ id: string; title: string }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      session: session(docId),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    };
    versions.mockResolvedValue({ versions: [current] });
    copyVersion
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);

    try {
      await renderStrictVersions(root, props, "A");
      fireEvent.click(await screen.findByText(current.title));
      fireEvent.click(screen.getByTestId("version-copy"));
      expect(copyVersion).toHaveBeenCalledOnce();

      await renderStrictVersions(root, props, "B");
      fireEvent.click(await screen.findByText(current.title));
      fireEvent.click(screen.getByTestId("version-copy"));
      expect(copyVersion).toHaveBeenCalledTimes(2);

      staleRequest.resolve({ id: "stale-strict-copy", title: "Stale" });
      await act(async () => {});
      expect(push).not.toHaveBeenCalled();
      expect(pendingNotice).not.toHaveBeenCalled();
      expect(screen.getByTestId("version-copy")).toBeDisabled();

      currentRequest.resolve({ id: "current-strict-copy", title: "Current" });
      await waitFor(() =>
        expect(push).toHaveBeenCalledExactlyOnceWith("/d/current-strict-copy"),
      );
      expect(pendingNotice).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("VersionsPanel · direct-root Strict Mode toolbar navigation", () => {
  let pathTerminalEvent: Event | null;
  let pathTerminalOverride: EventTarget | null;

  beforeEach(() => {
    pathTerminalEvent = null;
    pathTerminalOverride = null;
    normalizeVersionsToolbarOwnerWindowBoundary(window, (event, path) =>
      event === pathTerminalEvent && pathTerminalOverride
        ? [...path.slice(0, -1), pathTerminalOverride]
        : path,
    );
  });

  it("publishes a labelled, horizontal, ordered toolbar with one Refresh tab stop", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-semantics"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      const { toolbar, refresh, close } = versionsToolbarButtons(host);

      expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
      expect([...toolbar.children]).toEqual([refresh, close]);
      expect(refresh).toHaveAttribute("tabindex", "0");
      expect(close).toHaveAttribute("tabindex", "-1");
      expect(
        [refresh, close].filter((button) => button.tabIndex === 0),
      ).toHaveLength(1);
      expect(refresh).toHaveAttribute("title", "Refresh versions");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["ArrowRight", "refresh", "close"],
    ["ArrowDown", "refresh", "close"],
    ["ArrowLeft", "refresh", "close"],
    ["ArrowUp", "refresh", "close"],
    ["Home", "close", "refresh"],
    ["End", "refresh", "close"],
  ] as const)(
    "moves %s from %s to %s with one prevention and one non-scrolling focus",
    async (key, sourceName, destinationName) => {
      const nativePreventDefault = Event.prototype.preventDefault;
      const nativeFocus = HTMLElement.prototype.focus;
      const order: string[] = [];
      const preventDefault = vi
        .spyOn(Event.prototype, "preventDefault")
        .mockImplementation(function (this: Event) {
          order.push("prevent");
          nativePreventDefault.call(this);
        });
      const focus = vi
        .spyOn(HTMLElement.prototype, "focus")
        .mockImplementation(function (
          this: HTMLElement,
          options?: FocusOptions,
        ) {
          order.push("focus");
          nativeFocus.call(this, options);
        });
      const scrollIntoView = vi.fn();
      const originalScrollIntoView = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollIntoView",
      );
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        writable: true,
        value: scrollIntoView,
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();

      try {
        await renderStrictVersions(root, {
          session: session(`toolbar-${key}`),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        await screen.findByText(named.title!);
        let buttons = versionsToolbarButtons(host);
        const source = buttons[sourceName];
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        order.length = 0;
        const requests = versions.mock.calls.length;

        const result = await dispatchVersionsToolbarKey(source, key, {}, false);

        buttons = versionsToolbarButtons(host);
        const destination = buttons[destinationName];
        expect(result.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(focus.mock.instances[0]).toBe(destination);
        expect(order).toEqual(["prevent", "focus"]);
        expect(destination).toHaveFocus();
        expect(destination).toHaveAttribute("tabindex", "0");
        expect(sourceName === destinationName ? destination : buttons[sourceName])
          .toHaveAttribute(
            "tabindex",
            sourceName === destinationName ? "0" : "-1",
          );
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(versions).toHaveBeenCalledTimes(requests);
        expect(version).not.toHaveBeenCalled();
        expect(renameVersion).not.toHaveBeenCalled();
        expect(restoreVersion).not.toHaveBeenCalled();
        expect(copyVersion).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(onPreview).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
        if (originalScrollIntoView) {
          Object.defineProperty(
            Element.prototype,
            "scrollIntoView",
            originalScrollIntoView,
          );
        } else {
          delete (Element.prototype as { scrollIntoView?: unknown })
            .scrollIntoView;
        }
      }
    },
  );

  it.each([
    ["Home", "refresh"],
    ["End", "close"],
  ] as const)("leaves boundary %s inert on %s", async (key, sourceName) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session(`toolbar-boundary-${key}`),
        onClose,
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      const source = versionsToolbarButtons(host)[sourceName];
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = versions.mock.calls.length;

      const result = await dispatchVersionsToolbarKey(source, key, {}, false);

      expect(result.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      expect(versions).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("moves the sole tab stop to Close while Refresh is disabled", async () => {
    const refreshRequest = deferred<{ versions: VersionSummary[] }>();
    versions
      .mockResolvedValueOnce({ versions: [named] })
      .mockReturnValueOnce(refreshRequest.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-disabled-refresh"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      let buttons = versionsToolbarButtons(host);
      act(() => buttons.refresh.click());
      await waitFor(() => expect(buttons.refresh).toBeDisabled());

      buttons = versionsToolbarButtons(host);
      expect(buttons.refresh).toHaveAttribute("aria-busy", "true");
      expect(buttons.refresh).toHaveAttribute("tabindex", "-1");
      expect(buttons.close).toHaveAttribute("tabindex", "0");
      expect(
        [buttons.refresh, buttons.close].filter(
          (button) => button.tabIndex === 0,
        ),
      ).toHaveLength(1);
    } finally {
      refreshRequest.resolve({ versions: [named] });
      await act(async () => {
        await Promise.resolve();
        root.unmount();
      });
      host.remove();
    }
  });

  it("skips disabled Refresh while wrapping from the sole enabled Close action", async () => {
    const refreshRequest = deferred<{ versions: VersionSummary[] }>();
    versions
      .mockResolvedValueOnce({ versions: [named] })
      .mockReturnValueOnce(refreshRequest.promise);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-disabled-wrap"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      let buttons = versionsToolbarButtons(host);
      act(() => buttons.refresh.click());
      await waitFor(() => expect(buttons.refresh).toBeDisabled());
      buttons = versionsToolbarButtons(host);
      buttons.close.focus();
      focus.mockClear();
      const requests = versions.mock.calls.length;

      const accepted = await dispatchVersionsToolbarKey(
        buttons.close,
        "ArrowRight",
        {},
        false,
      );

      buttons = versionsToolbarButtons(host);
      expect(accepted.defaultPrevented).toBe(true);
      expect(buttons.close).toHaveFocus();
      expect(buttons.close).toHaveAttribute("tabindex", "0");
      expect(buttons.refresh).toHaveAttribute("tabindex", "-1");
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(focus.mock.instances[0]).toBe(buttons.close);
      expect(versions).toHaveBeenCalledTimes(requests);
    } finally {
      refreshRequest.resolve({ versions: [named] });
      await act(async () => {
        await Promise.resolve();
        root.unmount();
      });
      host.remove();
    }
  });

  it.each([
    ["Control modifier", { ctrlKey: true }, true, false],
    ["Alt modifier", { altKey: true }, true, false],
    ["Meta modifier", { metaKey: true }, true, false],
    ["Shift modifier", { shiftKey: true }, true, false],
    ["repeat", { repeat: true }, true, false],
    ["composition", { isComposing: true }, true, false],
    ["untrusted delivery", {}, false, false],
    ["prior prevention", {}, true, true],
  ] as const)(
    "rejects %s and still accepts a distinct current event",
    async (_label, init, trusted, preventFirst) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await renderStrictVersions(root, {
          session: session(`toolbar-invalid-${_label}`),
          onClose: vi.fn(),
          onPreview: vi.fn(),
          refreshKey: 0,
        });
        await screen.findByText(named.title!);
        const refresh = versionsToolbarButtons(host).refresh;
        refresh.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const invalid = createVersionsToolbarKey(
          refresh,
          "ArrowRight",
          init,
          trusted,
        );
        if (preventFirst) invalid.preventDefault();
        preventDefault.mockClear();

        await dispatchVersionsToolbarEvent(refresh, invalid, false);

        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(refresh).toHaveFocus();

        const current = versionsToolbarButtons(host).refresh;
        current.focus();
        focus.mockClear();
        const accepted = await dispatchVersionsToolbarKey(
          current,
          "ArrowRight",
          {},
          false,
        );
        expect(accepted.defaultPrevented).toBe(true);
        expect(versionsToolbarButtons(host).close).toHaveFocus();
        expect(focus).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("rejects an owner-document lookalike at the path terminal and accepts a clean successor", async () => {
    const lookalike: { document: Document; window: unknown } = {
      document,
      window: null,
    };
    lookalike.window = lookalike;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-owner-window-lookalike"),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      let buttons = versionsToolbarButtons(host);
      buttons.refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = versions.mock.calls.length;
      pathTerminalEvent = createVersionsToolbarKey(
        buttons.refresh,
        "ArrowRight",
      );
      pathTerminalOverride = lookalike as unknown as EventTarget;

      await dispatchVersionsToolbarEvent(
        buttons.refresh,
        pathTerminalEvent as KeyboardEvent,
        false,
      );

      buttons = versionsToolbarButtons(host);
      expect(pathTerminalEvent.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(buttons.refresh).toHaveFocus();
      expect(buttons.refresh).toHaveAttribute("tabindex", "0");
      expect(buttons.close).toHaveAttribute("tabindex", "-1");
      expect(versions).toHaveBeenCalledTimes(requests);
      expect(version).not.toHaveBeenCalled();
      expect(renameVersion).not.toHaveBeenCalled();
      expect(restoreVersion).not.toHaveBeenCalled();
      expect(copyVersion).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();

      pathTerminalEvent = null;
      pathTerminalOverride = null;
      const current = versionsToolbarButtons(host).refresh;
      current.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        current,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(versions).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects crossed deliveries and recovers with a clean event", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-crossed-events"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      const refresh = versionsToolbarButtons(host).refresh;
      refresh.focus();
      focus.mockClear();
      const first = createVersionsToolbarKey(refresh, "ArrowRight");
      const second = createVersionsToolbarKey(refresh, "ArrowRight");

      await act(async () => {
        refresh.dispatchEvent(first);
        refresh.dispatchEvent(second);
        await Promise.resolve();
      });

      expect(first.defaultPrevented).toBe(false);
      expect(second.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(refresh).toHaveFocus();

      const current = versionsToolbarButtons(host).refresh;
      current.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        current,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("leaves replayed and reentrant events inert after claiming navigation", async () => {
    const nativePreventDefault = Event.prototype.preventDefault;
    const nativeFocus = HTMLElement.prototype.focus;
    let refresh: HTMLButtonElement | null = null;
    let reentrant: KeyboardEvent | null = null;
    let entered = false;
    const preventDefault = vi
      .spyOn(Event.prototype, "preventDefault")
      .mockImplementation(function (this: Event) {
        nativePreventDefault.call(this);
        if (!entered && refresh && reentrant) {
          entered = true;
          refresh.dispatchEvent(reentrant);
        }
      });
    const focus = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function (
        this: HTMLElement,
        options?: FocusOptions,
      ) {
        nativeFocus.call(this, options);
      });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-reentrant-replay"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      refresh = versionsToolbarButtons(host).refresh;
      refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();
      reentrant = createVersionsToolbarKey(refresh, "ArrowRight");
      const accepted = createVersionsToolbarKey(refresh, "ArrowRight");

      await dispatchVersionsToolbarEvent(refresh, accepted, false);

      expect(accepted.defaultPrevented).toBe(true);
      expect(reentrant.defaultPrevented).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      const close = versionsToolbarButtons(host).close;
      expect(close).toHaveFocus();
      focus.mockClear();
      preventDefault.mockClear();

      await dispatchVersionsToolbarEvent(close, accepted, false);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(close).toHaveFocus();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects invalid delivery without work and accepts a clean successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(outside, host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-rejection-recovery"),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      let refresh = versionsToolbarButtons(host).refresh;
      outside.focus();
      focus.mockClear();
      const rejected = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(rejected.defaultPrevented).toBe(false);
      expect(outside).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();

      refresh = versionsToolbarButtons(host).refresh;
      refresh.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(version).not.toHaveBeenCalled();
      expect(renameVersion).not.toHaveBeenCalled();
      expect(restoreVersion).not.toHaveBeenCalled();
      expect(copyVersion).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      outside.remove();
      host.remove();
    }
  });

  it("retires a malformed React delivery and recovers with distinct handlers", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-react-recovery"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      const initial = versionsToolbarButtons(host).refresh;
      const stale = capturedProps(initial).onKeyDown;
      interceptEvent(
        initial,
        "onKeyDown",
        (original, event) => {
          Object.defineProperty(event, "isDefaultPrevented", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: () => true,
          });
          original(event);
        },
      );
      initial.focus();
      focus.mockClear();

      const rejected = await dispatchVersionsToolbarKey(
        initial,
        "ArrowRight",
        {},
        false,
      );
      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();

      const recovered = versionsToolbarButtons(host).refresh;
      expect(capturedProps(recovered).onKeyDown).not.toBe(stale);
      recovered.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        recovered,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects restored toolbar DOM and recovers through a clean render", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      session: session("toolbar-dom-recovery"),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    };

    try {
      await renderStrictVersions(root, props, "A");
      await screen.findByText(named.title!);
      let refresh = versionsToolbarButtons(host).refresh;
      const stale = capturedProps(refresh).onKeyDown;
      refresh.setAttribute("data-tampered", "true");
      refresh.removeAttribute("data-tampered");
      refresh.focus();
      focus.mockClear();

      const rejected = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();

      await renderStrictVersions(root, props, "B");
      refresh = versionsToolbarButtons(host).refresh;
      expect(capturedProps(refresh).onKeyDown).not.toBe(stale);
      refresh.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects a detached and restored panel ancestor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      session: session("toolbar-ancestor-recovery"),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    };

    try {
      await renderStrictVersions(root, props, "A");
      await screen.findByText(named.title!);
      let refresh = versionsToolbarButtons(host).refresh;
      const parent = host.parentNode;
      const nextSibling = host.nextSibling;
      if (!parent) throw new Error("Version panel host was not attached");
      host.remove();
      parent.insertBefore(host, nextSibling);
      refresh.focus();
      focus.mockClear();

      const rejected = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(refresh).toHaveFocus();

      await renderStrictVersions(root, props, "B");
      refresh = versionsToolbarButtons(host).refresh;
      refresh.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects partial ref replay and accepts a complete replacement", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      session: session("toolbar-partial-replay"),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    };

    try {
      await renderStrictVersions(root, props, "A");
      await screen.findByText(named.title!);
      let refresh = versionsToolbarButtons(host).refresh;
      const stale = capturedProps(refresh).onKeyDown;
      const ref = capturedProps(refresh).ref;
      if (!ref) throw new Error("Refresh ref was not attached");
      act(() => {
        ref(null);
        ref(refresh);
      });
      refresh.focus();
      focus.mockClear();

      const rejected = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();

      await renderStrictVersions(root, props, "B");
      refresh = versionsToolbarButtons(host).refresh;
      expect(capturedProps(refresh).onKeyDown).not.toBe(stale);
      refresh.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("uses the toolbar owner realm when mounted in an iframe", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerWindow = frame.contentWindow! as Window & typeof globalThis;
    const host = ownerWindow.document.createElement("div");
    ownerWindow.document.body.append(host);
    const root = createRoot(host);
    const nativeFocus = ownerWindow.HTMLElement.prototype.focus;
    normalizeVersionsToolbarOwnerWindowBoundary(ownerWindow);
    const focus = vi
      .spyOn(ownerWindow.HTMLElement.prototype, "focus")
      .mockImplementation(function (
        this: HTMLElement,
        options?: FocusOptions,
      ) {
        nativeFocus.call(this, options);
      });

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-owner-realm"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await waitFor(() =>
        expect(within(host).getByText(named.title!)).toBeInTheDocument(),
      );
      const refresh = versionsToolbarButtons(host).refresh;
      refresh.focus();
      focus.mockClear();

      const accepted = await dispatchVersionsToolbarKey(
        refresh,
        "ArrowRight",
        {},
        false,
      );

      expect(accepted.defaultPrevented).toBe(true);
      expect(versionsToolbarButtons(host).close).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
    } finally {
      await act(async () => root.unmount());
      frame.remove();
    }
  });

  it("leaves retained keyboard handlers inert after cleanup", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await renderStrictVersions(root, {
      session: session("toolbar-cleanup"),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    });
    await screen.findByText(named.title!);
    const refresh = versionsToolbarButtons(host).refresh;
    const stale = capturedProps(refresh).onKeyDown;
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    const nativeEvent = createVersionsToolbarKey(refresh, "ArrowRight");
    const preventDefault = vi.fn();
    focus.mockClear();

    stale?.({
      _reactName: "onKeyDown",
      type: "keydown",
      nativeEvent,
      currentTarget: refresh,
      target: refresh,
      key: "ArrowRight",
      preventDefault,
    } as unknown as CapturedEvent<HTMLButtonElement>);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    host.remove();
  });

  it("keeps Enter, Space, and native click activation separate from navigation", async () => {
    const refreshRequest = deferred<{ versions: VersionSummary[] }>();
    versions
      .mockResolvedValueOnce({ versions: [named] })
      .mockReturnValueOnce(refreshRequest.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session("toolbar-native-activation"),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText(named.title!);
      const { refresh, close } = versionsToolbarButtons(host);
      refresh.focus();
      const calls = versions.mock.calls.length;

      const enter = await dispatchVersionsToolbarKey(
        refresh,
        "Enter",
        {},
        false,
      );
      const space = await dispatchVersionsToolbarKey(
        refresh,
        " ",
        {},
        false,
      );
      expect(enter.defaultPrevented).toBe(false);
      expect(space.defaultPrevented).toBe(false);
      expect(versions).toHaveBeenCalledTimes(calls);

      act(() => refresh.click());
      expect(versions).toHaveBeenCalledTimes(calls + 1);
      act(() => close.click());
      expect(onClose).toHaveBeenCalledOnce();
      expect(onPreview).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      refreshRequest.resolve({ versions: [named] });
      await act(async () => {
        await Promise.resolve();
        root.unmount();
      });
      host.remove();
    }
  });
});

describe("VersionsPanel · direct-root Strict Mode row navigation", () => {
  const rowVersions: VersionSummary[] = [
    { ...named, id: "ver-4", number: 4, title: "Row four", createdAt: "2026-09-02T10:00:00.000Z" },
    { ...named, id: "ver-3", number: 3, title: "Row three", createdAt: "2026-09-02T09:00:00.000Z" },
    { ...named, id: "ver-2", number: 2, title: "Row two", createdAt: "2026-09-01T10:00:00.000Z" },
    { ...named, id: "ver-1", number: 1, title: "Row one", createdAt: "2026-09-01T09:00:00.000Z" },
  ];

  function expectNoVersionRowWork(
    onClose: ReturnType<typeof vi.fn>,
    onPreview: ReturnType<typeof vi.fn>,
    requests: number,
  ) {
    expect(versions).toHaveBeenCalledTimes(requests);
    expect(version).not.toHaveBeenCalled();
    expect(renameVersion).not.toHaveBeenCalled();
    expect(restoreVersion).not.toHaveBeenCalled();
    expect(copyVersion).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.queryByTestId("version-restore")).toBeNull();
    expect(screen.queryByTestId("version-rename-input")).toBeNull();
    expect(screen.queryByTestId("compare-hint")).toBeNull();
  }

  beforeEach(() => {
    versions.mockReset().mockResolvedValue({ versions: rowVersions });
  });

  it.each([
    ["ArrowDown", 0, 1],
    ["ArrowDown", 1, 2],
    ["ArrowDown", 3, 0],
    ["ArrowUp", 1, 0],
    ["ArrowUp", 2, 1],
    ["ArrowUp", 0, 3],
    ["Home", 2, 0],
    ["End", 1, 3],
  ] as const)(
    "moves %s from row %i to row %i with one prevention and one non-scrolling focus",
    async (key, sourceIndex, destinationIndex) => {
      const nativePreventDefault = Event.prototype.preventDefault;
      const nativeFocus = HTMLElement.prototype.focus;
      const order: string[] = [];
      const preventDefault = vi
        .spyOn(Event.prototype, "preventDefault")
        .mockImplementation(function (this: Event) {
          order.push("prevent");
          nativePreventDefault.call(this);
        });
      const focus = vi
        .spyOn(HTMLElement.prototype, "focus")
        .mockImplementation(function (
          this: HTMLElement,
          options?: FocusOptions,
        ) {
          order.push("focus");
          nativeFocus.call(this, options);
        });
      const scrollIntoView = vi.fn();
      const originalScrollIntoView = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollIntoView",
      );
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        writable: true,
        value: scrollIntoView,
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();

      try {
        await renderStrictVersions(root, {
          session: session(`rows-${key}-${sourceIndex}`),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        await screen.findByText("Row four");
        const source = versionRowSelects(host)[sourceIndex];
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        order.length = 0;
        const requests = versions.mock.calls.length;

        const result = await dispatchVersionsToolbarKey(source, key, {}, false);

        const rows = versionRowSelects(host);
        const destination = rows[destinationIndex];
        expect(result.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(focus.mock.instances[0]).toBe(destination);
        expect(order).toEqual(["prevent", "focus"]);
        expect(destination).toHaveFocus();
        expect(rows[sourceIndex]).toBe(source);
        expect(scrollIntoView).not.toHaveBeenCalled();
        expectNoVersionRowWork(onClose, onPreview, requests);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        if (originalScrollIntoView) {
          Object.defineProperty(
            Element.prototype,
            "scrollIntoView",
            originalScrollIntoView,
          );
        } else {
          delete (Element.prototype as { scrollIntoView?: unknown })
            .scrollIntoView;
        }
      }
    },
  );

  it("keeps one display order across day groups and moves over the boundary", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session("rows-day-groups"),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText("Row four");
      const lists = [...host.querySelectorAll("ul")];
      expect(lists).toHaveLength(2);
      const grouped = lists.flatMap((list) => versionRowSelects(list));
      expect(grouped).toEqual(versionRowSelects(host));
      expect(grouped).toHaveLength(4);
      expect(
        lists[0].querySelectorAll('[data-testid="version-item"]'),
      ).toHaveLength(2);
      const requests = versions.mock.calls.length;
      grouped[1].focus();
      focus.mockClear();

      const forward = await dispatchVersionsToolbarKey(
        grouped[1],
        "ArrowDown",
        {},
        false,
      );

      expect(forward.defaultPrevented).toBe(true);
      expect(versionRowSelects(host)[2]).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      focus.mockClear();

      const backward = await dispatchVersionsToolbarKey(
        versionRowSelects(host)[2],
        "ArrowUp",
        {},
        false,
      );

      expect(backward.defaultPrevented).toBe(true);
      expect(versionRowSelects(host)[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expectNoVersionRowWork(onClose, onPreview, requests);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("leaves the compare checkbox, action buttons, and rename input to native keys", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session("rows-native-controls"),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText("Row four");
      await act(async () => {
        versionRowSelects(host)[0].click();
        await Promise.resolve();
      });
      const item = within(host).getAllByTestId("version-item")[0];
      const checkbox = within(item).getByTestId("version-compare");
      const restore = within(item).getByTestId("version-restore");
      const reads = version.mock.calls.length;
      focus.mockClear();
      preventDefault.mockClear();

      const onCheckbox = await dispatchVersionsToolbarKey(
        checkbox,
        "ArrowDown",
        {},
        false,
      );
      restore.focus();
      focus.mockClear();
      const onRestore = await dispatchVersionsToolbarKey(
        restore,
        "ArrowDown",
        {},
        false,
      );

      expect(onCheckbox.defaultPrevented).toBe(false);
      expect(onRestore.defaultPrevented).toBe(false);
      expect(checkbox).not.toBeChecked();
      expect(restore).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      const navigation = versionRowSelects(host)[0];
      navigation.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const moved = await dispatchVersionsToolbarKey(
        navigation,
        "ArrowDown",
        {},
        false,
      );

      expect(moved.defaultPrevented).toBe(true);
      expect(versionRowSelects(host)[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(preventDefault).toHaveBeenCalledOnce();

      act(() => within(item).getByTestId("version-rename").click());
      const input = within(item).getByTestId("version-rename-input");
      input.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const onInput = await dispatchVersionsToolbarKey(
        input,
        "ArrowUp",
        {},
        false,
      );

      expect(onInput.defaultPrevented).toBe(false);
      expect(input).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(version).toHaveBeenCalledTimes(reads);
      expect(renameVersion).not.toHaveBeenCalled();
      expect(restoreVersion).not.toHaveBeenCalled();
      expect(copyVersion).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["Control modifier", { ctrlKey: true }, true, false],
    ["Alt modifier", { altKey: true }, true, false],
    ["Meta modifier", { metaKey: true }, true, false],
    ["Shift modifier", { shiftKey: true }, true, false],
    ["repeat", { repeat: true }, true, false],
    ["composition", { isComposing: true }, true, false],
    ["untrusted delivery", {}, false, false],
    ["prior prevention", {}, true, true],
  ] as const)(
    "rejects %s without work and still accepts a distinct current event",
    async (_label, init, trusted, preventFirst) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();

      try {
        await renderStrictVersions(root, {
          session: session(`rows-invalid-${_label}`),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        await screen.findByText("Row four");
        const source = versionRowSelects(host)[0];
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const requests = versions.mock.calls.length;
        const invalid = createVersionsToolbarKey(
          source,
          "ArrowDown",
          init,
          trusted,
        );
        if (preventFirst) invalid.preventDefault();
        preventDefault.mockClear();

        await dispatchVersionsToolbarEvent(source, invalid, false);

        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expectNoVersionRowWork(onClose, onPreview, requests);

        const current = versionRowSelects(host)[0];
        current.focus();
        focus.mockClear();
        const accepted = await dispatchVersionsToolbarKey(
          current,
          "ArrowDown",
          {},
          false,
        );

        expect(accepted.defaultPrevented).toBe(true);
        expect(versionRowSelects(host)[1]).toHaveFocus();
        expect(focus).toHaveBeenCalledOnce();
        expectNoVersionRowWork(onClose, onPreview, requests);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("rejects a delivery focused outside the row and accepts a clean successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(outside, host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    try {
      await renderStrictVersions(root, {
        session: session("rows-wrong-focus"),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText("Row four");
      const requests = versions.mock.calls.length;
      outside.focus();
      focus.mockClear();

      const rejected = await dispatchVersionsToolbarKey(
        versionRowSelects(host)[0],
        "ArrowDown",
        {},
        false,
      );

      expect(rejected.defaultPrevented).toBe(false);
      expect(outside).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expectNoVersionRowWork(onClose, onPreview, requests);

      const current = versionRowSelects(host)[0];
      current.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        current,
        "ArrowDown",
        {},
        false,
      );

      expect(accepted.defaultPrevented).toBe(true);
      expect(versionRowSelects(host)[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expectNoVersionRowWork(onClose, onPreview, requests);
    } finally {
      await act(async () => root.unmount());
      outside.remove();
      host.remove();
    }
  });

  it("binds the real Window receiver and rejects a structural path terminal before clean recovery", async () => {
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("Version rows had no owner window");
    const structural = Object.create(
      ownerWindow.Window.prototype,
    ) as EventTarget;
    Object.defineProperties(structural, {
      document: { value: document },
      Window: { value: ownerWindow.Window },
      Event: { value: ownerWindow.Event },
      EventTarget: { value: ownerWindow.EventTarget },
      KeyboardEvent: { value: ownerWindow.KeyboardEvent },
      Object: { value: ownerWindow.Object },
      Reflect: { value: ownerWindow.Reflect },
      window: { value: structural },
      self: { value: structural },
    });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const onPreview = vi.fn();
    const listenerObservation: {
      receiver?: EventTarget;
      currentTarget?: EventTarget | null;
      originalPathTerminal?: EventTarget;
    } = {};
    const stageTerminal = vi.fn(function (
      this: EventTarget,
      event: Event,
    ) {
      listenerObservation.receiver = this;
      listenerObservation.currentTarget = event.currentTarget;
      listenerObservation.originalPathTerminal = event.composedPath().at(-1);
      replaceVersionsJsdomPathTerminal(event, structural);
    });

    try {
      await renderStrictVersions(root, {
        session: session("rows-window-receiver"),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText("Row four");
      const source = versionRowSelects(host)[0];
      ownerWindow.addEventListener("keydown", stageTerminal, {
        capture: true,
        once: true,
      });
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = versions.mock.calls.length;

      const rejected = await dispatchVersionsToolbarKey(
        source,
        "ArrowDown",
        {},
        false,
      );

      expect(stageTerminal).toHaveBeenCalledOnce();
      expect(listenerObservation.receiver).toBe(
        listenerObservation.currentTarget,
      );
      expect(listenerObservation.receiver).toBe(
        listenerObservation.originalPathTerminal,
      );
      expect(listenerObservation.receiver).not.toBe(structural);
      expect(rejected.composedPath()).toEqual([]);
      expect(rejected.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      expectNoVersionRowWork(onClose, onPreview, requests);

      const current = versionRowSelects(host)[0];
      current.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        current,
        "ArrowDown",
        {},
        false,
      );

      expect(accepted.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(versionRowSelects(host)[1]).toHaveFocus();
      expectNoVersionRowWork(onClose, onPreview, requests);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["present", "absent", "mutated"] as const)(
    "ignores %s private React names while retaining public wrapper authority",
    async (privateName) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();
      let observed = false;

      try {
        await renderStrictVersions(root, {
          session: session(`rows-private-react-name-${privateName}`),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        await screen.findByText("Row four");
        const source = versionRowSelects(host)[0];
        interceptEvent(source, "onKeyDown", (original, event) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            event,
            "_reactName",
          );
          expect(descriptor?.value).toBe("onKeyDown");
          if (privateName === "absent") {
            expect(Reflect.deleteProperty(event, "_reactName")).toBe(true);
            expect(
              Object.getOwnPropertyDescriptor(event, "_reactName"),
            ).toBeUndefined();
          } else if (privateName === "mutated") {
            expect(Reflect.set(event, "_reactName", "private-lookalike")).toBe(
              true,
            );
            expect(
              Object.getOwnPropertyDescriptor(event, "_reactName")?.value,
            ).toBe("private-lookalike");
          }
          observed = true;
          original(event);
        });
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const requests = versions.mock.calls.length;

        const accepted = await dispatchVersionsToolbarKey(
          source,
          "ArrowDown",
          {},
          false,
        );

        expect(observed).toBe(true);
        expect(accepted.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(versionRowSelects(host)[1]).toHaveFocus();
        expectNoVersionRowWork(onClose, onPreview, requests);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("rejects crossed row deliveries and recovers with a clean event", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("rows-crossed-events"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText("Row four");
      const source = versionRowSelects(host)[0];
      source.focus();
      focus.mockClear();
      const first = createVersionsToolbarKey(source, "ArrowDown");
      const second = createVersionsToolbarKey(source, "ArrowDown");

      await act(async () => {
        source.dispatchEvent(first);
        source.dispatchEvent(second);
        await Promise.resolve();
      });

      expect(first.defaultPrevented).toBe(false);
      expect(second.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();

      const current = versionRowSelects(host)[0];
      current.focus();
      focus.mockClear();
      const accepted = await dispatchVersionsToolbarKey(
        current,
        "ArrowDown",
        {},
        false,
      );

      expect(accepted.defaultPrevented).toBe(true);
      expect(versionRowSelects(host)[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects restored row DOM and recovers through a clean render", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      session: session("rows-dom-recovery"),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    };

    try {
      await renderStrictVersions(root, props, "A");
      await screen.findByText("Row four");
      let source = versionRowSelects(host)[0];
      const stale = capturedProps(source).onKeyDown;
      source.setAttribute("data-tampered", "true");
      source.removeAttribute("data-tampered");
      source.focus();
      focus.mockClear();

      const rejected = await dispatchVersionsToolbarKey(
        source,
        "ArrowDown",
        {},
        false,
      );

      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();

      await renderStrictVersions(root, props, "B");
      await screen.findByText("Row four");
      source = versionRowSelects(host)[0];
      expect(capturedProps(source).onKeyDown).not.toBe(stale);
      source.focus();
      focus.mockClear();

      const accepted = await dispatchVersionsToolbarKey(
        source,
        "ArrowDown",
        {},
        false,
      );

      expect(accepted.defaultPrevented).toBe(true);
      expect(versionRowSelects(host)[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("leaves a replayed event inert after claiming row navigation", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrictVersions(root, {
        session: session("rows-replay"),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText("Row four");
      const source = versionRowSelects(host)[0];
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const accepted = createVersionsToolbarKey(source, "ArrowDown");

      await dispatchVersionsToolbarEvent(source, accepted, false);

      expect(accepted.defaultPrevented).toBe(true);
      const destination = versionRowSelects(host)[1];
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(preventDefault).toHaveBeenCalledOnce();
      focus.mockClear();
      preventDefault.mockClear();

      await dispatchVersionsToolbarEvent(destination, accepted, false);

      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(destination).toHaveFocus();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("leaves retained row keyboard handlers inert after cleanup", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await renderStrictVersions(root, {
      session: session("rows-cleanup"),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    });
    await screen.findByText("Row four");
    const source = versionRowSelects(host)[0];
    const stale = capturedProps(source).onKeyDown;
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    const nativeEvent = createVersionsToolbarKey(source, "ArrowDown");
    const preventDefault = vi.fn();
    focus.mockClear();

    stale?.({
      _reactName: "onKeyDown",
      type: "keydown",
      nativeEvent,
      currentTarget: source,
      target: source,
      key: "ArrowDown",
      preventDefault,
    } as unknown as CapturedEvent<HTMLButtonElement>);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    host.remove();
  });
});

describe("VersionsPanel · manual refresh authority", () => {
  it("keeps cached rows visible, coalesces activation, and replaces the list once", async () => {
    const docId = "manual-refresh-success";
    const current = {
      ...named,
      id: `${docId}-current`,
      title: "Current cached version",
    };
    const older = {
      ...named,
      id: `${docId}-older`,
      number: 0,
      title: "Older cached version",
    };
    const refreshed = {
      ...named,
      id: `${docId}-refreshed`,
      number: 2,
      title: "Fresh version",
    };
    const request = deferred<{ versions: VersionSummary[] }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current, older] })
      .mockReturnValueOnce(request.promise);

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(current.title);
      const refresh = screen.getByRole<HTMLButtonElement>("button", {
        name: "Refresh versions",
      });
      const restore = interceptClick(refresh, (original, event) => {
        original(event);
        original(event);
      });

      act(() => refresh.click());
      restore();
      act(() => refresh.click());

      expect(versions).toHaveBeenCalledTimes(2);
      expect(refresh).toBeDisabled();
      expect(refresh).toHaveAttribute("aria-busy", "true");
      expect(screen.getAllByTestId("version-item")).toHaveLength(2);
      expect(screen.getByText(current.title)).toBeInTheDocument();
      expect(screen.getByText(older.title)).toBeInTheDocument();

      request.resolve({ versions: [refreshed] });
      expect(await screen.findByText(refreshed.title)).toBeInTheDocument();
      expect(screen.queryByText(current.title)).toBeNull();
      expect(screen.queryByText(older.title)).toBeNull();
      expect(screen.getAllByTestId("version-item")).toHaveLength(1);
      expect(refresh).toBeEnabled();
      expect(refresh).not.toHaveAttribute("aria-busy");
      expect(versions).toHaveBeenCalledTimes(2);
      expect(versions).toHaveBeenNthCalledWith(2, docId);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retains rows and interaction state on failure, then recovers through Retry", async () => {
    const docId = "manual-refresh-retry";
    const current = {
      ...named,
      id: `${docId}-current`,
      title: "Refresh retry current",
    };
    const older = {
      ...named,
      id: `${docId}-older`,
      number: 0,
      title: "Refresh retry older",
    };
    const failed = deferred<{ versions: VersionSummary[] }>();
    const retryRequest = deferred<{ versions: VersionSummary[] }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPreview = vi.fn();
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current, older] })
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retryRequest.promise);
    version.mockResolvedValue({
      version: { ...current, content: "# Refresh retry" },
    });

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview,
        refreshKey: 0,
      });
      fireEvent.click(await screen.findByText(current.title));
      await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
      fireEvent.click(
        screen.getByRole("checkbox", { name: `Compare v${current.number}` }),
      );
      await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
      onPreview.mockClear();

      fireEvent.click(
        screen.getByRole("button", { name: "Refresh versions" }),
      );
      failed.reject(new Error("manual refresh unavailable"));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "manual refresh unavailable",
      );
      expect(screen.getAllByTestId("version-item")).toHaveLength(2);
      expect(screen.getByText(current.title)).toBeInTheDocument();
      expect(screen.getByText(older.title)).toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", {
          name: `Compare v${current.number}`,
        }),
      ).toBeChecked();
      expect(screen.getByTestId("version-restore")).toBeInTheDocument();
      expect(onPreview).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Refresh versions" }),
        ).toBeEnabled(),
      );

      const retry = screen.getByRole<HTMLButtonElement>("button", {
        name: "Retry",
      });
      fireEvent.click(retry);
      fireEvent.click(retry);
      await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));
      expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
      expect(screen.getAllByTestId("version-item")).toHaveLength(2);

      retryRequest.resolve({ versions: [current, older] });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(
        screen.getByRole("checkbox", {
          name: `Compare v${current.number}`,
        }),
      ).toBeChecked();
      expect(screen.getByTestId("version-restore")).toBeInTheDocument();
      expect(onPreview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "lets an external refresh retire a pending manual refresh before its late %s",
    async (settlement) => {
      const docId = `manual-refresh-external-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `External initial ${settlement}`,
      };
      const stale = {
        ...named,
        id: `${docId}-stale`,
        title: `External stale ${settlement}`,
      };
      const current = {
        ...named,
        id: `${docId}-current`,
        title: `External current ${settlement}`,
      };
      const manual = deferred<{ versions: VersionSummary[] }>();
      const external = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const props = {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
      };
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(manual.promise)
        .mockReturnValueOnce(external.promise);

      try {
        await renderStrictVersions(root, { ...props, refreshKey: 0 });
        await screen.findByText(initial.title);
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        await renderStrictVersions(root, { ...props, refreshKey: 1 });
        await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));

        external.resolve({ versions: [current] });
        expect(await screen.findByText(current.title)).toBeInTheDocument();
        await act(async () => {
          if (settlement === "resolve") {
            manual.resolve({ versions: [stale] });
          } else {
            manual.reject(new Error("obsolete manual failure"));
          }
          await Promise.resolve();
        });

        expect(screen.getByText(current.title)).toBeInTheDocument();
        expect(screen.queryByText(stale.title)).toBeNull();
        expect(screen.queryByText("obsolete manual failure")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(props.onPreview).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
        expect(versions).toHaveBeenCalledTimes(3);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "lets a mutation reload retire a pending manual refresh before its late %s",
    async (settlement) => {
      const docId = `manual-refresh-mutation-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `Mutation initial ${settlement}`,
      };
      const renamed = {
        ...initial,
        title: `Mutation renamed ${settlement}`,
      };
      const stale = {
        ...initial,
        title: `Mutation stale ${settlement}`,
      };
      const manual = deferred<{ versions: VersionSummary[] }>();
      const reload = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onPreview = vi.fn();
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(manual.promise)
        .mockReturnValueOnce(reload.promise);
      renameVersion.mockResolvedValueOnce({ ok: true });

      try {
        await renderStrictVersions(root, {
          session: session(docId),
          onClose: vi.fn(),
          onPreview,
          refreshKey: 0,
        });
        fireEvent.click(await screen.findByText(initial.title));
        await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
        onPreview.mockClear();
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        fireEvent.click(screen.getByTestId("version-rename"));
        fireEvent.change(screen.getByTestId("version-rename-input"), {
          target: { value: renamed.title },
        });
        fireEvent.keyDown(screen.getByTestId("version-rename-input"), {
          key: "Enter",
        });
        await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));

        reload.resolve({ versions: [renamed] });
        expect(await screen.findByText(renamed.title)).toBeInTheDocument();
        await act(async () => {
          if (settlement === "resolve") {
            manual.resolve({ versions: [stale] });
          } else {
            manual.reject(new Error("obsolete mutation refresh"));
          }
          await Promise.resolve();
        });

        expect(screen.getByText(renamed.title)).toBeInTheDocument();
        expect(screen.queryByText(stale.title)).toBeNull();
        expect(screen.queryByText("obsolete mutation refresh")).toBeNull();
        expect(onPreview).not.toHaveBeenCalled();
        expect(renameVersion).toHaveBeenCalledExactlyOnceWith(
          docId,
          initial.id,
          renamed.title,
        );
        expect(versions).toHaveBeenCalledTimes(3);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["session", "callbacks"] as const)(
    "retires a manual refresh after same-document %s identity drift",
    async (replacement) => {
      const docId = `manual-refresh-${replacement}-drift`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `${replacement} drift initial`,
      };
      const stale = {
        ...named,
        id: `${docId}-stale`,
        title: `${replacement} drift stale`,
      };
      const current = {
        ...named,
        id: `${docId}-current`,
        title: `${replacement} drift current`,
      };
      const staleRequest = deferred<{ versions: VersionSummary[] }>();
      const currentRequest = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const firstSession = session(docId);
      const nextSession =
        replacement === "session" ? session(docId) : firstSession;
      const firstClose = vi.fn();
      const firstPreview = vi.fn();
      const nextClose = replacement === "callbacks" ? vi.fn() : firstClose;
      const nextPreview =
        replacement === "callbacks" ? vi.fn() : firstPreview;
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(staleRequest.promise)
        .mockReturnValueOnce(currentRequest.promise);

      try {
        await renderStrictVersions(root, {
          session: firstSession,
          onClose: firstClose,
          onPreview: firstPreview,
          refreshKey: 0,
        });
        await screen.findByText(initial.title);
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        await renderStrictVersions(root, {
          session: nextSession,
          onClose: nextClose,
          onPreview: nextPreview,
          refreshKey: 0,
        });

        staleRequest.resolve({ versions: [stale] });
        await act(async () => {});
        expect(screen.getByText(initial.title)).toBeInTheDocument();
        expect(screen.queryByText(stale.title)).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();

        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        expect(versions).toHaveBeenCalledTimes(3);
        currentRequest.resolve({ versions: [current] });
        expect(await screen.findByText(current.title)).toBeInTheDocument();
        expect(firstClose).not.toHaveBeenCalled();
        expect(firstPreview).not.toHaveBeenCalled();
        expect(nextClose).not.toHaveBeenCalled();
        expect(nextPreview).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "isolates a replaced document from an old manual refresh %s",
    async (settlement) => {
      const oldDocId = `manual-refresh-old-document-${settlement}`;
      const newDocId = `manual-refresh-new-document-${settlement}`;
      const oldVersion = {
        ...named,
        id: `${oldDocId}-version`,
        title: `Old document ${settlement}`,
      };
      const staleVersion = {
        ...named,
        id: `${oldDocId}-stale`,
        title: `Stale document ${settlement}`,
      };
      const newVersion = {
        ...named,
        id: `${newDocId}-version`,
        title: `New document ${settlement}`,
      };
      const staleRequest = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [oldVersion] })
        .mockReturnValueOnce(staleRequest.promise)
        .mockResolvedValueOnce({ versions: [newVersion] });

      try {
        await renderStrictVersions(root, {
          session: session(oldDocId),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        await screen.findByText(oldVersion.title);
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        await renderStrictVersions(root, {
          session: session(newDocId),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        expect(await screen.findByText(newVersion.title)).toBeInTheDocument();

        await act(async () => {
          if (settlement === "resolve") {
            staleRequest.resolve({ versions: [staleVersion] });
          } else {
            staleRequest.reject(new Error("obsolete document refresh"));
          }
          await Promise.resolve();
        });
        expect(screen.getByText(newVersion.title)).toBeInTheDocument();
        expect(screen.queryByText(staleVersion.title)).toBeNull();
        expect(screen.queryByText("obsolete document refresh")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(onPreview).not.toHaveBeenCalled();
        expect(versions).toHaveBeenNthCalledWith(3, newDocId);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps a replacement mount independent of an old manual refresh %s",
    async (settlement) => {
      const docId = `manual-refresh-mount-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `Mount initial ${settlement}`,
      };
      const stale = {
        ...named,
        id: `${docId}-stale`,
        title: `Mount stale ${settlement}`,
      };
      const current = {
        ...named,
        id: `${docId}-current`,
        title: `Mount current ${settlement}`,
      };
      const staleRequest = deferred<{ versions: VersionSummary[] }>();
      const currentRequest = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();
      const props = {
        session: session(docId),
        onClose,
        onPreview,
        refreshKey: 0,
      };
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(staleRequest.promise)
        .mockReturnValueOnce(currentRequest.promise);

      try {
        await renderStrictVersions(root, props, "A");
        await screen.findByText(initial.title);
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        await renderStrictVersions(root, props, "B");
        await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));

        currentRequest.resolve({ versions: [current] });
        expect(await screen.findByText(current.title)).toBeInTheDocument();
        await act(async () => {
          if (settlement === "resolve") {
            staleRequest.resolve({ versions: [stale] });
          } else {
            staleRequest.reject(new Error("obsolete mount refresh"));
          }
          await Promise.resolve();
        });
        expect(screen.getByText(current.title)).toBeInTheDocument();
        expect(screen.queryByText(stale.title)).toBeNull();
        expect(screen.queryByText("obsolete mount refresh")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(onPreview).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "drops a late manual refresh %s after cleanup",
    async (settlement) => {
      const docId = `manual-refresh-cleanup-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `Cleanup initial ${settlement}`,
      };
      const request = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(request.promise);

      await renderStrictVersions(root, {
        session: session(docId),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText(initial.title);
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh versions" }),
      );
      await act(async () => root.unmount());
      await act(async () => {
        if (settlement === "resolve") {
          request.resolve({
            versions: [{ ...initial, title: "Too late after cleanup" }],
          });
        } else {
          request.reject(new Error("too late after cleanup"));
        }
        await Promise.resolve();
      });

      expect(host).toBeEmptyDOMElement();
      expect(onClose).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();
      expect(versions).toHaveBeenCalledTimes(2);
      host.remove();
    },
  );

  it("rejects stale and forged Refresh events without consuming the exact current control", async () => {
    const docId = "manual-refresh-exact-event";
    const current = {
      ...named,
      id: `${docId}-current`,
      title: "Exact refresh event",
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      session: session(docId),
      onClose: vi.fn(),
      onPreview: vi.fn(),
      refreshKey: 0,
    };
    versions.mockResolvedValue({ versions: [current] });

    try {
      await renderStrictVersions(root, props, "A");
      await screen.findByText(current.title);
      const staleButton = screen.getByRole<HTMLButtonElement>("button", {
        name: "Refresh versions",
      });
      const staleRefresh = capturedProps(staleButton).onClick;
      await renderStrictVersions(root, props, "B");
      const currentRefresh = screen.getByRole<HTMLButtonElement>("button", {
        name: "Refresh versions",
      });
      const close = screen.getByRole<HTMLButtonElement>("button", {
        name: "Close version history",
      });
      const callsBefore = versions.mock.calls.length;
      const restoreClose = interceptClick(close, (_original, event) => {
        staleRefresh?.(
          cloneSyntheticEvent(event, {
            currentTarget: currentRefresh,
            target: currentRefresh,
          }),
        );
      });

      act(() => close.click());
      restoreClose();
      expect(versions).toHaveBeenCalledTimes(callsBefore);
      expect(props.onClose).not.toHaveBeenCalled();

      const restoreRefresh = interceptClick(
        currentRefresh,
        (original, event) => {
          staleRefresh?.(event);
          original(event);
          original(event);
        },
      );
      act(() => currentRefresh.click());
      restoreRefresh();
      await waitFor(() =>
        expect(versions).toHaveBeenCalledTimes(callsBefore + 1),
      );
      expect(props.onClose).not.toHaveBeenCalled();
      expect(props.onPreview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["attribute", "detach", "order", "replace"] as const)(
    "permanently retires Refresh after restored %s DOM custody",
    async (tamper) => {
      const docId = `manual-refresh-dom-${tamper}`;
      const current = {
        ...named,
        id: `${docId}-current`,
        title: `Refresh DOM ${tamper}`,
      };
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const props = {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      };
      versions.mockResolvedValue({ versions: [current] });

      try {
        await renderStrictVersions(root, props, "A");
        await screen.findByText(current.title);
        const refresh = screen.getByRole<HTMLButtonElement>("button", {
          name: "Refresh versions",
        });
        const close = screen.getByRole<HTMLButtonElement>("button", {
          name: "Close version history",
        });
        const controls = refresh.parentElement!;
        const callsBefore = versions.mock.calls.length;

        if (tamper === "attribute") {
          refresh.setAttribute("aria-label", "Altered refresh");
          refresh.setAttribute("aria-label", "Refresh versions");
        } else if (tamper === "detach") {
          refresh.remove();
          controls.insertBefore(refresh, close);
        } else if (tamper === "order") {
          controls.insertBefore(close, refresh);
          controls.append(close);
        } else {
          const replacement = refresh.cloneNode(true);
          controls.replaceChild(replacement, refresh);
          controls.replaceChild(refresh, replacement);
        }

        act(() => refresh.click());
        expect(versions).toHaveBeenCalledTimes(callsBefore);
        expect(props.onClose).not.toHaveBeenCalled();
        expect(props.onPreview).not.toHaveBeenCalled();

        await renderStrictVersions(root, props, "B");
        const currentRefresh = screen.getByRole<HTMLButtonElement>("button", {
          name: "Refresh versions",
        });
        act(() => currentRefresh.click());
        await waitFor(() =>
          expect(versions).toHaveBeenCalledTimes(callsBefore + 2),
        );
        expect(props.onClose).not.toHaveBeenCalled();
        expect(props.onPreview).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
});

describe("VersionsPanel · rename a version", () => {
  it("shows the server's validation reason, not the bare 'Invalid request', when the title is rejected", async () => {
    renameVersion.mockRejectedValueOnce(new ApiError(400, "Invalid request", [{ path: ["title"], message: "Title must be 1–200 characters" }]));
    const session = { docId: DOC_ID, role: "owner" } as unknown as CollabSession;
    render(<VersionsPanel session={session} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);

    const [item] = await screen.findAllByTestId("version-item");
    fireEvent.click(within(item).getByText("Draft"));
    fireEvent.click(await screen.findByTestId("version-rename"));
    const input = screen.getByTestId("version-rename-input");
    fireEvent.change(input, { target: { value: "Final" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Title must be 1–200 characters")).toBeInTheDocument();
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(renameVersion).toHaveBeenCalledWith(DOC_ID, "ver-1", "Final");
  });
});

describe("VersionsPanel · mutation ownership", () => {
  it("starts one confirmed Restore for two immediate activations and owns its one reload", async () => {
    const docId = "mutation-restore-once";
    const current = { ...named, id: "restore-once", title: "Restore once" };
    const restoreRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    const onPreview = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Restore once"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith({ version: current, content: "# Draft" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked());
    onPreview.mockClear();

    const restoreButton = screen.getByTestId("version-restore");
    fireEvent.click(restoreButton);
    fireEvent.click(restoreButton);

    expect(confirm).toHaveBeenCalledOnce();
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(restoreVersion).toHaveBeenCalledWith(docId, current.id);
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Restore once")).not.toBeNull();

    restoreRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).not.toBeChecked();
    expect(spinnerFor("Restore once")).not.toBeNull();

    reloadRequest.resolve({ versions: [current] });
    await waitFor(() => expect(spinnerFor("Restore once")).toBeNull());
    expect(versions).toHaveBeenNthCalledWith(2, docId);
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("declining Restore claims nothing and preserves the current preview intent", async () => {
    const docId = "mutation-restore-declined";
    const current = { ...named, id: "restore-declined", title: "Restore declined" };
    const onPreview = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    versions.mockResolvedValueOnce({ versions: [current] });

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Restore declined"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked());
    onPreview.mockClear();

    fireEvent.click(screen.getByTestId("version-restore"));

    expect(confirm).toHaveBeenCalledOnce();
    expect(restoreVersion).not.toHaveBeenCalled();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Restore declined")).toBeNull();
  });

  it("releases a failed Restore for one retry and reloads only after the retry succeeds", async () => {
    const docId = "mutation-restore-retry";
    const current = { ...named, id: "restore-retry", title: "Restore retry" };
    const firstRequest = deferred<{ ok: boolean }>();
    const retryRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    restoreVersion.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(retryRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Restore retry"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();

    fireEvent.click(screen.getByTestId("version-restore"));
    firstRequest.reject(new Error("restore unavailable"));
    expect(await screen.findByText("restore unavailable")).toBeInTheDocument();
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Restore retry")).toBeNull();

    fireEvent.click(screen.getByTestId("version-restore"));
    expect(screen.queryByText("restore unavailable")).toBeNull();
    expect(restoreVersion).toHaveBeenCalledTimes(2);
    expectMutationControlsToBeDisabled(true);
    retryRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    reloadRequest.resolve({ versions: [current] });
    await waitFor(() => expect(spinnerFor("Restore retry")).toBeNull());
    expect(restoreVersion).toHaveBeenNthCalledWith(2, docId, current.id);
    expect(versions).toHaveBeenNthCalledWith(2, docId);
  });

  it("submits an Enter-plus-blur Rename once with the trimmed title", async () => {
    const docId = "mutation-rename-once";
    const current = { ...named, id: "rename-once", title: "Rename once" };
    const renamed = { ...current, title: "Final title" };
    const renameRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    const onPreview = vi.fn();
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    renameVersion.mockReturnValueOnce(renameRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Rename once"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-rename"));
    const input = screen.getByTestId("version-rename-input");
    fireEvent.change(input, { target: { value: "  Final title  " } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    });

    expect(renameVersion).toHaveBeenCalledOnce();
    expect(renameVersion).toHaveBeenCalledWith(docId, current.id, "Final title");
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Rename once")).not.toBeNull();

    renameRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    expect(spinnerFor("Rename once")).not.toBeNull();
    reloadRequest.resolve({ versions: [renamed] });
    expect(await screen.findByText("Final title")).toBeInTheDocument();
    await waitFor(() => expect(spinnerFor("Final title")).toBeNull());
    expect(onPreview).not.toHaveBeenCalled();
    expect(versions).toHaveBeenNthCalledWith(2, docId);
  });

  it("releases a failed Rename for one retry and refreshes only after the retry succeeds", async () => {
    const docId = "mutation-rename-retry";
    const current = { ...named, id: "rename-retry", title: "Rename retry" };
    const renamed = { ...current, title: "Recovered title" };
    const firstRequest = deferred<{ ok: boolean }>();
    const retryRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    renameVersion.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(retryRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Rename retry"));
    fireEvent.click(screen.getByTestId("version-rename"));
    fireEvent.change(screen.getByTestId("version-rename-input"), { target: { value: "Recovered title" } });
    fireEvent.blur(screen.getByTestId("version-rename-input"));
    firstRequest.reject(new Error("rename unavailable"));

    expect(await screen.findByText("rename unavailable")).toBeInTheDocument();
    expect(renameVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Rename retry")).toBeNull();

    fireEvent.click(screen.getByTestId("version-rename"));
    fireEvent.change(screen.getByTestId("version-rename-input"), { target: { value: " Recovered title " } });
    fireEvent.keyDown(screen.getByTestId("version-rename-input"), { key: "Enter" });
    expect(screen.queryByText("rename unavailable")).toBeNull();
    expect(renameVersion).toHaveBeenCalledTimes(2);
    expectMutationControlsToBeDisabled(true);
    retryRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    reloadRequest.resolve({ versions: [renamed] });
    expect(await screen.findByText("Recovered title")).toBeInTheDocument();
    await waitFor(() => expect(spinnerFor("Recovered title")).toBeNull());
    expect(renameVersion).toHaveBeenNthCalledWith(2, docId, current.id, "Recovered title");
    expect(versions).toHaveBeenNthCalledWith(2, docId);
  });

  it("starts one Copy for two immediate activations and navigates once", async () => {
    const docId = "mutation-copy-once";
    const current = { ...named, id: "copy-once", title: "Copy once" };
    const copyRequest = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(copyRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Copy once"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    const copyButton = screen.getByTestId("version-copy");
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    expect(copyVersion).toHaveBeenCalledOnce();
    expect(copyVersion).toHaveBeenCalledWith(docId, current.id);
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Copy once")).not.toBeNull();
    copyRequest.resolve({ id: "copied-document", title: "Copied title" });

    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(push).toHaveBeenCalledWith("/d/copied-document");
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(pendingNotice).toHaveBeenCalledWith("Created “Copied title” from version 1.", "success");
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Copy once")).toBeNull();
  });

  it("releases a failed Copy for one retry and publishes effects only after success", async () => {
    const docId = "mutation-copy-retry";
    const current = { ...named, id: "copy-retry", title: "Copy retry" };
    const firstRequest = deferred<{ id: string; title: string }>();
    const retryRequest = deferred<{ id: string; title: string }>();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(retryRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Copy retry"));
    fireEvent.click(screen.getByTestId("version-copy"));
    firstRequest.reject(new Error("copy unavailable"));

    expect(await screen.findByText("copy unavailable")).toBeInTheDocument();
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Copy retry")).toBeNull();

    fireEvent.click(screen.getByTestId("version-copy"));
    expect(screen.queryByText("copy unavailable")).toBeNull();
    expect(copyVersion).toHaveBeenCalledTimes(2);
    expectMutationControlsToBeDisabled(true);
    retryRequest.resolve({ id: "copy-retry-document", title: "Recovered copy" });

    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(pendingNotice).toHaveBeenCalledWith("Created “Recovered copy” from version 1.", "success");
    expect(push).toHaveBeenCalledWith("/d/copy-retry-document");
    expect(copyVersion).toHaveBeenNthCalledWith(2, docId, current.id);
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(false);
  });

  it("blocks every other mutation kind while one Restore is pending", async () => {
    const docId = "mutation-cross-kind";
    const current = { ...named, id: "cross-kind", title: "Cross kind" };
    const restoreRequest = deferred<{ ok: boolean }>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockResolvedValueOnce({ versions: [current] });
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Cross kind"));
    const renameButton = screen.getByTestId("version-rename");
    const copyButton = screen.getByTestId("version-copy");
    fireEvent.click(screen.getByTestId("version-restore"));
    fireEvent.click(renameButton);
    fireEvent.click(copyButton);
    fireEvent.click(screen.getByTestId("version-restore"));

    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(renameVersion).not.toHaveBeenCalled();
    expect(copyVersion).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Cross kind")).not.toBeNull();

    restoreRequest.reject(new Error("release owner"));
    expect(await screen.findByText("release owner")).toBeInTheDocument();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Cross kind")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("ignores a late Restore %s after Close", async (settlement) => {
    const docId = `mutation-close-restore-${settlement}`;
    const current = { ...named, id: `close-restore-${settlement}`, title: `Close restore ${settlement}` };
    const restoreRequest = deferred<{ ok: boolean }>();
    const onClose = vi.fn();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockResolvedValueOnce({ versions: [current] });
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={onClose} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText(`Close restore ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-restore"));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(spinnerFor(`Close restore ${settlement}`)).toBeNull();
    if (settlement === "resolve") restoreRequest.resolve({ ok: true });
    else restoreRequest.reject(new Error("obsolete restore failure"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();
    expect(screen.queryByText("obsolete restore failure")).toBeNull();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a late Copy %s after Close", async (settlement) => {
    const docId = `mutation-close-copy-${settlement}`;
    const current = { ...named, id: `close-copy-${settlement}`, title: `Close copy ${settlement}` };
    const copyRequest = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(copyRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText(`Close copy ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-copy"));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(spinnerFor(`Close copy ${settlement}`)).toBeNull();

    if (settlement === "resolve") copyRequest.resolve({ id: "obsolete-copy", title: "Obsolete copy" });
    else copyRequest.reject(new Error("obsolete copy failure"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(copyVersion).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(screen.queryByText("obsolete copy failure")).toBeNull();
    expect(versions).toHaveBeenCalledOnce();
  });

  it("keeps the new document's Copy owner when the replaced document's Restore settles", async () => {
    const oldDocId = "mutation-replacement-old";
    const newDocId = "mutation-replacement-new";
    const oldVersion = { ...named, id: "replacement-old-version", title: "Replacement old" };
    const newVersion = { ...named, id: "replacement-new-version", title: "Replacement new" };
    const oldRestore = deferred<{ ok: boolean }>();
    const currentCopy = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockImplementation((docId: string) => Promise.resolve({ versions: [docId === oldDocId ? oldVersion : newVersion] }));
    restoreVersion.mockReturnValueOnce(oldRestore.promise);
    copyVersion.mockReturnValueOnce(currentCopy.promise);
    const props = { onClose: vi.fn(), onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} session={session(oldDocId)} />);
    fireEvent.click(await screen.findByText("Replacement old"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByTestId("version-restore"));
    rendered.rerender(<VersionsPanel {...props} session={session(newDocId)} />);
    fireEvent.click(await screen.findByText("Replacement new"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-copy"));
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Replacement new")).not.toBeNull();

    oldRestore.resolve({ ok: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(restoreVersion).toHaveBeenCalledWith(oldDocId, oldVersion.id);
    expect(versions).toHaveBeenCalledTimes(2);
    expect(onPreview).not.toHaveBeenCalled();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Replacement new")).not.toBeNull();

    currentCopy.resolve({ id: "replacement-copy", title: "Current copy" });
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(copyVersion).toHaveBeenCalledWith(newDocId, newVersion.id);
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(pendingNotice).toHaveBeenCalledWith("Created “Current copy” from version 1.", "success");
    expect(push).toHaveBeenCalledWith("/d/replacement-copy");
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Replacement new")).toBeNull();
  });

  it.each([
    ["restore", "resolve"],
    ["restore", "reject"],
    ["copy", "resolve"],
    ["copy", "reject"],
  ] as const)("retires an old %s before its layout-settled %s reaches UI after replacement", async (kind, settlement) => {
    const oldDocId = `mutation-layout-old-${kind}-${settlement}`;
    const newDocId = `mutation-layout-new-${kind}-${settlement}`;
    const oldVersion = { ...named, id: `layout-old-${kind}-${settlement}`, title: `Layout old ${kind} ${settlement}` };
    const newVersion = { ...named, id: `layout-new-${kind}-${settlement}`, title: `Layout new ${kind} ${settlement}` };
    const mutation = deferred<unknown>();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockImplementation((docId: string) => Promise.resolve({ versions: [docId === oldDocId ? oldVersion : newVersion] }));
    if (kind === "restore") restoreVersion.mockReturnValueOnce(mutation.promise);
    else copyVersion.mockReturnValueOnce(mutation.promise);
    const props = { onClose: vi.fn(), onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} session={session(oldDocId)} />);
    fireEvent.click(await screen.findByText(`Layout old ${kind} ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId(kind === "restore" ? "version-restore" : "version-copy"));

    const settle = () => {
      if (settlement === "reject") mutation.reject(new Error("obsolete layout failure"));
      else if (kind === "restore") mutation.resolve({ ok: true });
      else mutation.resolve({ id: "obsolete-layout-copy", title: "Obsolete layout copy" });
    };
    rendered.rerender(
      <>
        <VersionsPanel {...props} session={session(newDocId)} />
        <SettleInLayout settle={settle} />
      </>,
    );

    expect(await screen.findByText(`Layout new ${kind} ${settlement}`)).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(versions).toHaveBeenCalledTimes(2);
    expect(versions).toHaveBeenNthCalledWith(1, oldDocId);
    expect(versions).toHaveBeenNthCalledWith(2, newDocId);
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.queryByText("obsolete layout failure")).toBeNull();
    expect(screen.queryByText(`Layout old ${kind} ${settlement}`)).toBeNull();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    if (kind === "restore") expect(restoreVersion).toHaveBeenCalledOnce();
    else expect(copyVersion).toHaveBeenCalledOnce();
  });

  it("does not let an old layout-settled finalizer unlock the newer Copy owner", async () => {
    const docId = "mutation-layout-newer-owner";
    const current = { ...named, id: "layout-newer-owner-version", title: "Layout newer owner" };
    const oldRestore = deferred<{ ok: boolean }>();
    const currentCopy = deferred<{ id: string; title: string }>();
    const onClose = vi.fn();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockResolvedValueOnce({ versions: [current] });
    restoreVersion.mockReturnValueOnce(oldRestore.promise);
    copyVersion.mockReturnValueOnce(currentCopy.promise);
    const props = { session: session(docId), onClose, onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} />);
    fireEvent.click(await screen.findByText("Layout newer owner"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByTestId("version-restore"));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    fireEvent.click(screen.getByTestId("version-copy"));
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Layout newer owner")).not.toBeNull();

    rendered.rerender(
      <>
        <VersionsPanel {...props} />
        <SettleInLayout settle={() => oldRestore.resolve({ ok: true })} />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Layout newer owner")).not.toBeNull();

    currentCopy.resolve({ id: "layout-current-copy", title: "Layout current copy" });
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/d/layout-current-copy");
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Layout newer owner")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("ignores a late Copy %s after unmount", async (settlement) => {
    const docId = `mutation-unmount-${settlement}`;
    const current = { ...named, id: `mutation-unmount-version-${settlement}`, title: `Mutation unmount ${settlement}` };
    const copyRequest = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(copyRequest.promise);

    const rendered = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText(`Mutation unmount ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-copy"));
    rendered.unmount();
    if (settlement === "resolve") copyRequest.resolve({ id: "too-late", title: "Too late" });
    else copyRequest.reject(new Error("too late"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("lets an owned post-Rename reload supersede an older list request", async () => {
    const docId = "mutation-owned-list";
    const current = { ...named, id: "owned-list-version", title: "Owned list current" };
    const renamed = { ...current, title: "Owned list renamed" };
    const stale = { ...current, title: "Stale list result" };
    const renameRequest = deferred<{ ok: boolean }>();
    const olderList = deferred<{ versions: VersionSummary[] }>();
    const ownedList = deferred<{ versions: VersionSummary[] }>();
    const nextRefresh = deferred<{ versions: VersionSummary[] }>();
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current] })
      .mockReturnValueOnce(olderList.promise)
      .mockReturnValueOnce(ownedList.promise)
      .mockReturnValueOnce(nextRefresh.promise);

    const first = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    await screen.findByText("Owned list current");
    await waitFor(() => expect(versions).toHaveBeenCalledOnce());
    first.unmount();

    renameVersion.mockReturnValueOnce(renameRequest.promise);
    const second = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    expect(screen.getByText("Owned list current")).toBeInTheDocument();
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("Owned list current"));
    fireEvent.click(await screen.findByTestId("version-rename"));
    fireEvent.change(screen.getByTestId("version-rename-input"), { target: { value: "Owned list renamed" } });
    fireEvent.keyDown(screen.getByTestId("version-rename-input"), { key: "Enter" });
    renameRequest.resolve({ ok: true });

    await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));
    expect(spinnerFor("Owned list current")).not.toBeNull();
    ownedList.resolve({ versions: [renamed] });
    expect(await screen.findByText("Owned list renamed")).toBeInTheDocument();
    await waitFor(() => expect(spinnerFor("Owned list renamed")).toBeNull());
    olderList.resolve({ versions: [stale] });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Owned list renamed")).toBeInTheDocument();
    expect(screen.queryByText("Stale list result")).toBeNull();
    expect(versions).toHaveBeenCalledTimes(3);
    second.unmount();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    expect(screen.getByText("Owned list renamed")).toBeInTheDocument();
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(4));
    expect(versions).toHaveBeenNthCalledWith(2, docId);
    expect(versions).toHaveBeenNthCalledWith(3, docId);
    expect(renameVersion).toHaveBeenCalledOnce();
  });
});

describe("VersionsPanel · compare target", () => {
  it("keeps each compact checkbox inside a labelled 24px target that toggles the intended version", async () => {
    const older = { ...named, id: "ver-0", number: 0, title: "Earlier" };
    versions.mockResolvedValueOnce({ versions: [named, older] });
    version.mockImplementation(async (_docId: string, versionId: string) => ({
      version: { ...(versionId === named.id ? named : older), content: versionId === named.id ? "# Draft" : "# Earlier" },
    }));
    const onPreview = vi.fn();
    const session = { docId: DOC_ID, role: "owner" } as unknown as CollabSession;
    render(<VersionsPanel session={session} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);

    const draft = await screen.findByRole("checkbox", { name: "Compare v1" });
    const earlier = await screen.findByRole("checkbox", { name: "Compare v0" });
    for (const checkbox of [draft, earlier]) {
      expect(checkbox).toHaveClass("h-3.5", "w-3.5");
      expect(checkbox.closest("label")).toHaveClass("h-6", "w-6");
    }

    fireEvent.click(draft.closest("label")!);
    expect(draft).toBeChecked();
    expect(earlier).not.toBeChecked();

    fireEvent.click(earlier.closest("label")!);
    expect(draft).toBeChecked();
    expect(earlier).toBeChecked();
    await waitFor(() =>
      expect(onPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          version: expect.objectContaining({ id: named.id }),
          base: expect.objectContaining({ version: expect.objectContaining({ id: older.id }) }),
        }),
      ),
    );
  });
});

describe("VersionsPanel · list recovery", () => {
  it("replaces an initial failure with an unfocused retry that makes one request and reaches the empty state", async () => {
    const retry = deferred<{ versions: VersionSummary[] }>();
    const onClose = vi.fn();
    versions.mockReset().mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);

    render(<VersionsPanel session={session("versions-retry-empty")} onClose={onClose} onPreview={vi.fn()} refreshKey={0} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load versions");
    expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(alert).not.toHaveFocus();
    expect(retryButton).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Close version history" })).toBeEnabled();

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(versions).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ versions: [] });
    expect(await screen.findByText("No versions yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(versions).toHaveBeenNthCalledWith(2, "versions-retry-empty");
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps rows, selection, compare state and cached content through a refresh failure", async () => {
    const older = { ...named, id: "ver-0-recovery", number: 0, title: "Earlier" };
    const current = { ...named, id: "ver-1-recovery" };
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current, older] })
      .mockRejectedValueOnce("refresh unavailable")
      .mockResolvedValueOnce({ versions: [current, older] });
    version.mockResolvedValue({ version: { ...current, content: "# Draft" } });
    const onPreview = vi.fn();
    const props = { session: session("versions-cached"), onClose: vi.fn(), onPreview };
    const rendered = render(<VersionsPanel {...props} refreshKey={0} />);

    const [item] = await screen.findAllByTestId("version-item");
    fireEvent.click(within(item).getByText("Draft"));
    await waitFor(() => expect(version).toHaveBeenCalledTimes(1));
    const compare = screen.getByRole("checkbox", { name: "Compare v1" });
    fireEvent.click(compare);
    expect(compare).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();

    rendered.rerender(<VersionsPanel {...props} refreshKey={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load versions");
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Earlier")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();

    fireEvent.click(within(screen.getAllByTestId("version-item")[0]).getByText("Draft"));
    fireEvent.click(within(screen.getAllByTestId("version-item")[0]).getByText("Draft"));
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ version: expect.objectContaining({ id: current.id }) })));
    expect(version).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();
    expect(versions).toHaveBeenCalledTimes(3);
  });

  it("ignores an older document response after the panel switches documents", async () => {
    const oldRequest = deferred<{ versions: VersionSummary[] }>();
    const newRequest = deferred<{ versions: VersionSummary[] }>();
    const oldVersion = { ...named, id: "old-version", title: "Old document version" };
    const newVersion = { ...named, id: "new-version", title: "New document version" };
    versions.mockReset().mockImplementation((docId: string) => (docId === "versions-old" ? oldRequest.promise : newRequest.promise));

    const rendered = render(<VersionsPanel session={session("versions-old")} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    await waitFor(() => expect(versions).toHaveBeenCalledWith("versions-old"));
    rendered.rerender(<VersionsPanel session={session("versions-new")} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    await waitFor(() => expect(versions).toHaveBeenCalledWith("versions-new"));

    newRequest.resolve({ versions: [newVersion] });
    expect(await screen.findByText("New document version")).toBeInTheDocument();
    oldRequest.resolve({ versions: [oldVersion] });
    await act(async () => {});
    expect(screen.getByText("New document version")).toBeInTheDocument();
    expect(screen.queryByText("Old document version")).toBeNull();
  });
});

describe("VersionsPanel · preview intent ownership", () => {
  it.each([
    ["older request settles first", "older-first"],
    ["newer request settles first", "newer-first"],
  ] as const)("keeps rapid A-then-B selection on B when the %s", async (_label, settlementOrder) => {
    const docId = `rapid-selection-${settlementOrder}`;
    const alpha = { ...named, id: `alpha-${settlementOrder}`, number: 1, title: "Alpha" };
    const beta = { ...named, id: `beta-${settlementOrder}`, number: 2, title: "Beta" };
    const alphaRequest = deferred<ReturnType<typeof contentResult>>();
    const betaRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [beta, alpha] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === alpha.id ? alphaRequest.promise : betaRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByText("Beta"));

    expect(version).toHaveBeenNthCalledWith(1, docId, alpha.id);
    expect(version).toHaveBeenNthCalledWith(2, docId, beta.id);
    expect(spinnerFor("Alpha")).toBeNull();
    expect(spinnerFor("Beta")).not.toBeNull();

    if (settlementOrder === "older-first") {
      await act(async () => {
        alphaRequest.resolve(contentResult(alpha, "# Alpha"));
        await Promise.resolve();
      });
      expect(onPreview).not.toHaveBeenCalled();
      expect(spinnerFor("Beta")).not.toBeNull();
      await act(async () => {
        betaRequest.resolve(contentResult(beta, "# Beta"));
        await Promise.resolve();
      });
    } else {
      await act(async () => {
        betaRequest.resolve(contentResult(beta, "# Beta"));
        await Promise.resolve();
      });
      expect(onPreview).toHaveBeenCalledOnce();
      await act(async () => {
        alphaRequest.resolve(contentResult(alpha, "# Alpha"));
        await Promise.resolve();
      });
    }

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith({ version: beta, content: "# Beta" });
    expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull();
  });

  it("lets a two-version comparison supersede a pending single-version preview", async () => {
    const docId = "single-to-comparison";
    const older = { ...named, id: "single-older", number: 1, title: "Comparison older" };
    const newer = { ...named, id: "single-newer", number: 2, title: "Comparison newer" };
    const olderRequest = deferred<ReturnType<typeof contentResult>>();
    const newerRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [newer, older] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === older.id ? olderRequest.promise : newerRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Comparison newer");
    fireEvent.click(screen.getByText("Comparison newer"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v2" }));

    expect(version).toHaveBeenCalledTimes(2);
    expect(version).toHaveBeenCalledWith(docId, older.id);
    expect(version).toHaveBeenCalledWith(docId, newer.id);
    await act(async () => {
      newerRequest.resolve(contentResult(newer, "# Newer"));
      await Promise.resolve();
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(spinnerFor("Comparison newer")).not.toBeNull();

    await act(async () => {
      olderRequest.resolve(contentResult(older, "# Older"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({
      version: newer,
      content: "# Newer",
      base: { version: older, content: "# Older" },
      range: [newer],
    });
  });

  it("keeps Clear authoritative over a pending comparison", async () => {
    const docId = "comparison-clear";
    const older = { ...named, id: "clear-older", number: 1, title: "Clear older" };
    const newer = { ...named, id: "clear-newer", number: 2, title: "Clear newer" };
    const olderRequest = deferred<ReturnType<typeof contentResult>>();
    const newerRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [newer, older] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === older.id ? olderRequest.promise : newerRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Clear older");
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    onPreview.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v2" }));
    expect(version).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull();

    await act(async () => {
      olderRequest.resolve(contentResult(older, "# Older"));
      newerRequest.reject(new Error("obsolete comparison"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("obsolete comparison")).toBeNull();
    expect(version).toHaveBeenCalledTimes(2);
  });

  it("does not let a pending preview reopen after Close", async () => {
    const docId = "preview-close";
    const request = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: "close-version", title: "Close pending" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(request.promise);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={onClose} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Close pending");
    fireEvent.click(screen.getByText("Close pending"));
    expect(spinnerFor("Close pending")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(spinnerFor("Close pending")).toBeNull();
    await act(async () => {
      request.resolve(contentResult(current, "# Too late"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(version).toHaveBeenCalledOnce();
  });

  it("keeps Restore busy after the obsolete preview settles", async () => {
    const docId = "preview-restore";
    const previewRequest = deferred<ReturnType<typeof contentResult>>();
    const restoreRequest = deferred<{ ok: boolean }>();
    const current = { ...named, id: "restore-version", title: "Restore pending" };
    versions.mockResolvedValue({ versions: [current] });
    version.mockReturnValueOnce(previewRequest.promise);
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Restore pending");
    fireEvent.click(screen.getByText("Restore pending"));
    fireEvent.click(screen.getByTestId("version-restore"));

    expect(restoreVersion).toHaveBeenCalledWith(docId, current.id);
    expect(spinnerFor("Restore pending")).not.toBeNull();
    expectMutationControlsToBeDisabled(true);
    await act(async () => {
      previewRequest.resolve(contentResult(current, "# Obsolete"));
      await Promise.resolve();
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(spinnerFor("Restore pending")).not.toBeNull();
    expectMutationControlsToBeDisabled(true);

    await act(async () => {
      restoreRequest.resolve({ ok: true });
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    await waitFor(() => expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull());
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledTimes(2);
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps Copy busy when its version preview finishes first", async () => {
    const docId = "preview-copy";
    const previewRequest = deferred<ReturnType<typeof contentResult>>();
    const copyRequest = deferred<{ id: string; title: string }>();
    const current = { ...named, id: "copy-version", title: "Copy pending" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(previewRequest.promise);
    copyVersion.mockReturnValueOnce(copyRequest.promise);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Copy pending");
    fireEvent.click(screen.getByText("Copy pending"));
    fireEvent.click(screen.getByTestId("version-copy"));

    expect(copyVersion).toHaveBeenCalledWith(docId, current.id);
    expect(spinnerFor("Copy pending")).not.toBeNull();
    expectMutationControlsToBeDisabled(true);
    await act(async () => {
      previewRequest.resolve(contentResult(current, "# Preview"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(spinnerFor("Copy pending")).not.toBeNull();
    expectMutationControlsToBeDisabled(true);

    await act(async () => {
      copyRequest.reject(new Error("copy failed"));
      await Promise.resolve();
    });
    expect(screen.getByText("copy failed")).toBeInTheDocument();
    expect(spinnerFor("Copy pending")).toBeNull();
    expectMutationControlsToBeDisabled(false);
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("coalesces concurrent reads of the same version", async () => {
    const docId = "preview-coalescing";
    const request = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: "coalesced-version", title: "Coalesced" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(request.promise);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Coalesced");
    fireEvent.click(screen.getByText("Coalesced"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));

    expect(version).toHaveBeenCalledOnce();
    expect(version).toHaveBeenCalledWith(docId, current.id);
    await act(async () => {
      request.resolve(contentResult(current, "# Shared"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({ version: current, content: "# Shared" });
  });

  it("retries once with a fresh request after the current content read fails", async () => {
    const docId = "preview-retry";
    const failedRequest = deferred<ReturnType<typeof contentResult>>();
    const retryRequest = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: "retry-version", title: "Retry content" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(failedRequest.promise).mockReturnValueOnce(retryRequest.promise);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Retry content");
    fireEvent.click(screen.getByText("Retry content"));
    await act(async () => {
      failedRequest.reject(new Error("offline"));
      await Promise.resolve();
    });
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(version).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    expect(screen.queryByText("offline")).toBeNull();
    expect(spinnerFor("Retry content")).not.toBeNull();
    expect(version).toHaveBeenCalledTimes(2);
    expect(version).toHaveBeenNthCalledWith(2, docId, current.id);
    await act(async () => {
      retryRequest.resolve(contentResult(current, "# Recovered"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({ version: current, content: "# Recovered" });
    expect(version).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale failure without clearing the current preview spinner", async () => {
    const docId = "stale-preview-failure";
    const alpha = { ...named, id: "stale-alpha", number: 1, title: "Stale alpha" };
    const beta = { ...named, id: "stale-beta", number: 2, title: "Current beta" };
    const alphaRequest = deferred<ReturnType<typeof contentResult>>();
    const betaRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [beta, alpha] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === alpha.id ? alphaRequest.promise : betaRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Stale alpha");
    fireEvent.click(screen.getByText("Stale alpha"));
    fireEvent.click(screen.getByText("Current beta"));
    await act(async () => {
      alphaRequest.reject(new Error("obsolete failure"));
      await Promise.resolve();
    });

    expect(screen.queryByText("obsolete failure")).toBeNull();
    expect(onPreview).not.toHaveBeenCalled();
    expect(spinnerFor("Current beta")).not.toBeNull();
    await act(async () => {
      betaRequest.resolve(contentResult(beta, "# Current"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({ version: beta, content: "# Current" });
  });

  it.each(["resolve", "reject"] as const)("ignores a late content %s after unmount", async (settlement) => {
    const docId = `preview-unmount-${settlement}`;
    const request = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: `unmount-${settlement}`, title: `Unmount ${settlement}` };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(request.promise);
    const onPreview = vi.fn();

    const rendered = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText(`Unmount ${settlement}`);
    fireEvent.click(screen.getByText(`Unmount ${settlement}`));
    rendered.unmount();
    await act(async () => {
      if (settlement === "resolve") request.resolve(contentResult(current, "# Too late"));
      else request.reject(new Error("too late"));
      await Promise.resolve();
    });

    expect(onPreview).not.toHaveBeenCalled();
    expect(version).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("ignores an old document's late content %s after replacement", async (settlement) => {
    const oldDocId = `preview-old-${settlement}`;
    const newDocId = `preview-new-${settlement}`;
    const request = deferred<ReturnType<typeof contentResult>>();
    const oldVersion = { ...named, id: `old-content-${settlement}`, title: `Old content ${settlement}` };
    const newVersion = { ...named, id: `new-content-${settlement}`, title: `New content ${settlement}` };
    versions.mockImplementation((docId: string) => Promise.resolve({ versions: [docId === oldDocId ? oldVersion : newVersion] }));
    version.mockReturnValueOnce(request.promise);
    const onPreview = vi.fn();
    const props = { onClose: vi.fn(), onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} session={session(oldDocId)} />);
    await screen.findByText(`Old content ${settlement}`);
    fireEvent.click(screen.getByText(`Old content ${settlement}`));
    rendered.rerender(<VersionsPanel {...props} session={session(newDocId)} />);
    expect(await screen.findByText(`New content ${settlement}`)).toBeInTheDocument();

    await act(async () => {
      if (settlement === "resolve") request.resolve(contentResult(oldVersion, "# Too late"));
      else request.reject(new Error("too late"));
      await Promise.resolve();
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.queryByText("too late")).toBeNull();
    expect(screen.getByText(`New content ${settlement}`)).toBeInTheDocument();
    expect(version).toHaveBeenCalledWith(oldDocId, oldVersion.id);
  });
});
